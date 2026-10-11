import type { SourceProjectionV1 } from "./contracts";
import type { EmbeddedNote, NoteEmbeddingSeam } from "../jobs/noteJob";

export interface LiveEmbeddingCacheOptions {
  maxEntries: number;
  maxBytes: number;
  /** Optional combined-budget guard. Receives retained bytes plus one active returned clone. */
  canRetain?: (projectedResidentBytes: number) => boolean;
}

export type CachedLiveEmbeddingSeam = NoteEmbeddingSeam & {
  clear(): void;
  readonly retainedBytes: number;
};

function identityKey(identity: SourceProjectionV1["identity"]): string {
  return identity.kind === "apple-annotation" ? `apple-annotation:${identity.appleAnnotationId}` : `path:${identity.canonicalPath}`;
}

function cloneEmbedded(value: EmbeddedNote): EmbeddedNote {
  return {
    model: value.model,
    dimension: value.dimension,
    noteVector: value.noteVector.slice(),
    chunkVectors: value.chunkVectors.map((vector) => vector.slice()),
  };
}

function retainedSize(value: EmbeddedNote): number {
  return value.noteVector.byteLength + value.chunkVectors.reduce((total, vector) => total + vector.byteLength, 0);
}

/** Bounded LRU for completed live-query embeddings. In-flight work is deliberately not shared. */
export function createCachedLiveEmbeddingSeam(inner: NoteEmbeddingSeam, options: LiveEmbeddingCacheOptions): CachedLiveEmbeddingSeam {
  if (!Number.isInteger(options.maxEntries) || options.maxEntries < 0 || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new Error("live embedding cache limits must be non-negative integers.");
  }
  const entries = new Map<string, { value: EmbeddedNote; bytes: number }>();
  let bytes = 0;

  function clear(): void {
    entries.clear();
    bytes = 0;
  }

  return {
    async embed(projection: SourceProjectionV1, signal: AbortSignal): Promise<EmbeddedNote> {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const key = JSON.stringify([identityKey(projection.identity), projection.sourceHash]);
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
        return cloneEmbedded(hit.value);
      }

      const produced = await inner.embed(projection, signal);
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const entryBytes = retainedSize(produced);
      const replacedBytes = entries.get(key)?.bytes ?? 0;
      const projectedBytes = bytes - replacedBytes + entryBytes;
      if (options.maxEntries > 0 && entryBytes <= options.maxBytes && (options.canRetain?.(projectedBytes + entryBytes) ?? true)) {
        const replaced = entries.get(key);
        if (replaced) {
          bytes -= replaced.bytes;
          entries.delete(key);
        }
        while (entries.size >= options.maxEntries || bytes + entryBytes > options.maxBytes) {
          const oldestKey = entries.keys().next().value;
          if (oldestKey === undefined) break;
          const oldest = entries.get(oldestKey);
          if (oldest) bytes -= oldest.bytes;
          entries.delete(oldestKey);
        }
        const retained = cloneEmbedded(produced);
        entries.set(key, { value: retained, bytes: entryBytes });
        bytes += entryBytes;
      }
      return produced;
    },
    clear,
    get retainedBytes() { return bytes; },
  };
}
