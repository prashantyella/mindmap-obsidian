import { joinRelative } from "../engine/atomicStore";
import { generationDirPath, loadCurrentGenerationManifest, loadGeneration, type GenerationLoadOptions, type LoadedGeneration } from "./generationStore";
import type { IndexFs } from "./indexFs";
import type { VectorIndexManifestV1 } from "./vectorTypes";
import { BUDGET_STEADY_STATE_MEMORY_BYTES, computeSteadyStateBytesWithOverlays } from "./budgets";
import { throwIfAborted } from "./cooperativeWork";

interface Entry {
  generation: LoadedGeneration | null;
  paths: string[];
  fingerprints: string[];
}

function artifactPaths(root: string, manifest: VectorIndexManifestV1): string[] {
  const dir = generationDirPath(manifest.generationId);
  return [
    joinRelative(root, "current.json"),
    joinRelative(root, `${dir}/manifest.json`),
    joinRelative(root, `${dir}/notes.mvx`),
    joinRelative(root, `${dir}/notes.meta.json`),
    ...manifest.chunkShards.flatMap((shard) => [
      joinRelative(root, `${dir}/shards/${shard.shardId}.mvx`),
      joinRelative(root, `${dir}/shards/${shard.shardId}.offsets.json`),
    ]),
  ];
}

/** One fully verified base-generation lease. Filesystems without stable fingerprints always take the uncached path. */
export class QueryGenerationCache {
  private entry: Entry | null = null;
  private pending: Promise<LoadedGeneration | null> | null = null;
  private leaseTail: Promise<void> = Promise.resolve();

  constructor(private readonly fs: IndexFs, private readonly root: string) {}

  clear(): void { this.entry = null; }

  canRetainAdditionalBytes(bytes: number): boolean {
    const manifest = this.entry?.generation?.manifest;
    if (!manifest) return false;
    const largestShardCount = manifest.chunkShards.reduce((largest, shard) => Math.max(largest, shard.count), 0);
    return computeSteadyStateBytesWithOverlays({ dimension: manifest.dimension, noteCount: manifest.noteCount, largestShardCount }) + bytes <= BUDGET_STEADY_STATE_MEMORY_BYTES;
  }

  /** Serializes active readers so only one shard/payload and one generation transition can be resident at once. */
  run<T>(reader: (generation: LoadedGeneration | null) => Promise<T>, loadOptions: GenerationLoadOptions = {}): Promise<T> {
    const result = this.leaseTail.then(async () => {
      throwIfAborted(loadOptions.signal);
      return reader(await this.get(loadOptions));
    });
    this.leaseTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async get(options: GenerationLoadOptions = {}): Promise<LoadedGeneration | null> {
    const { signal } = options;
    throwIfAborted(signal);
    if (!this.fs.statFingerprint) {
      const manifest = await loadCurrentGenerationManifest(this.fs, this.root);
      throwIfAborted(signal);
      return manifest ? loadGeneration(this.fs, this.root, manifest.generationId, options) : null;
    }
    if (signal || options.onStage) return this.resolve(0, options);
    if (this.pending) return this.pending;
    this.pending = this.resolve(0);
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async fingerprints(paths: readonly string[]): Promise<string[]> {
    return Promise.all(paths.map((path) => this.fs.statFingerprint!(path)));
  }

  private async resolve(attempt: number, options: GenerationLoadOptions = {}): Promise<LoadedGeneration | null> {
    const { signal } = options;
    throwIfAborted(signal);
    if (this.entry) {
      try {
        const current = await this.fingerprints(this.entry.paths);
        throwIfAborted(signal);
        if (current.every((value, index) => value === this.entry!.fingerprints[index])) return this.entry.generation;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        // Missing/replaced files invalidate the entry; the cold path below fails closed.
      }
      this.entry = null;
    }

    const manifest = await loadCurrentGenerationManifest(this.fs, this.root);
    throwIfAborted(signal);
    if (!manifest) return null;
    const pointerPath = joinRelative(this.root, "current.json");
    const pointerBefore = await this.fs.statFingerprint!(pointerPath);

    const paths = artifactPaths(this.root, manifest);
    const before = await this.fingerprints(paths);
    throwIfAborted(signal);
    if (before[0] !== pointerBefore) return this.retry(attempt, options);
    const generation = await loadGeneration(this.fs, this.root, manifest.generationId, options);
    const after = await this.fingerprints(paths);
    const finalManifest = await loadCurrentGenerationManifest(this.fs, this.root);
    throwIfAborted(signal);
    if (finalManifest?.generationId !== manifest.generationId || !after.every((value, index) => value === before[index])) return this.retry(attempt, options);
    this.entry = { generation, paths, fingerprints: after };
    return generation;
  }

  private retry(attempt: number, options: GenerationLoadOptions): Promise<LoadedGeneration | null> {
    if (attempt >= 2) throw new Error("index generation changed repeatedly while establishing a verified query snapshot.");
    return this.resolve(attempt + 1, options);
  }
}
