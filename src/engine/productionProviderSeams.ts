import type { EmbeddingProvider } from "./embeddingProvider";
import { EngineError } from "./errors";
import { classifyFailureCode } from "../jobs/jobTypes";
import { MAX_EMBEDDING_DIMENSION } from "./embeddingLimits";
import { chunkText } from "./chunker";
import type { MetadataInferenceProvider } from "./metadataPipeline";
import { runMetadataPipeline, type MetadataPipelineConfig } from "./metadataPipeline";
import type { EmbeddedNote, NoteEmbeddingSeam, NoteMetadataSeam } from "../jobs/noteJob";
import type { SourceProjectionV1 } from "./contracts";
import { isUnitNorm } from "./vectorValidation";

/** Mirrors `noteJob.ts`'s own private `isFiniteVectorLike` (duplicated rather than shared -- a dense, non-sparse, finite-number vector shape check small enough that each caller owning its own copy costs nothing and avoids a cross-module coupling neither side needs). */
function isFiniteVectorLike(value: unknown): value is Float32Array | number[] {
  if (value instanceof Float32Array) return true;
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || typeof value[index] !== "number") return false;
  }
  return true;
}

/**
 * Checkpoint 10A sub-milestone C, item 7: the seam's OWN strict response
 * validation, independent of (and never a substitute for) `NoteJobRunner`'s
 * own downstream `validateEmbeddedNote` re-check -- a caller-supplied
 * provider result gets exactly as little trust here as anywhere else. The
 * bounded batch id set requested (`"note"` plus `"chunk:0"..."chunk:N-1"`)
 * must come back with EXACT cardinality/uniqueness: no missing id, no
 * duplicate id, no extra/unrecognized id silently ignored -- a provider
 * that returns the right id set plus a stray extra entry (a bug, or a
 * response mixed up across a concurrent request) fails closed here rather
 * than quietly succeeding on the subset this code happens to look up.
 */
function assertExactIdSet(requestedIds: readonly string[], responseItems: readonly { id: string }[]): void {
  if (responseItems.length !== requestedIds.length) {
    throw new EngineError("EMBEDDING_COUNT_MISMATCH", "Embedding provider returned a different number of items than requested.", {
      requested: requestedIds.length,
      received: responseItems.length,
    });
  }
  const seen = new Set<string>();
  for (const item of responseItems) {
    if (seen.has(item.id)) {
      throw new EngineError("EMBEDDING_RESPONSE_INVALID", "Embedding provider returned a duplicate item id.");
    }
    seen.add(item.id);
  }
  const requested = new Set(requestedIds);
  for (const id of seen) {
    if (!requested.has(id)) {
      throw new EngineError("EMBEDDING_RESPONSE_INVALID", "Embedding provider returned an id that was never requested.");
    }
  }
  for (const id of requested) {
    if (!seen.has(id)) {
      throw new EngineError("EMBEDDING_RESPONSE_INVALID", "Embedding provider did not return every requested item.");
    }
  }
}

/** Every returned vector must be a dense, unit-norm array/`Float32Array` of exactly `dimension` values -- checked here (not just downstream in `NoteJobRunner.validateEmbeddedNote`) so a malformed provider result never even reaches this seam's own return value. */
function assertDenseUnitVector(values: unknown, dimension: number): asserts values is Float32Array | number[] {
  if (!isFiniteVectorLike(values) || values.length !== dimension) {
    throw new EngineError("EMBEDDING_DIMENSION_MISMATCH", "Embedding provider returned a vector of the wrong dimension.");
  }
  if (!isUnitNorm(values)) {
    throw new EngineError("EMBEDDING_VECTOR_INVALID", "Embedding provider returned a non-unit-length vector.");
  }
}

/**
 * Production `NoteEmbeddingSeam`: embeds the note's own projected body PLUS
 * every one of its chunks in ONE `embedBatch` call, keyed by caller-
 * assigned correlation ids (`"note"` / `"chunk:<index>"`) so the result is
 * never reassembled by array position alone.
 *
 * Item 7: `chunkOptions` (target/overlap tokens) is a REQUIRED, caller-
 * configured argument -- never a hardcoded production default baked into
 * this seam. Neither the note's own text nor any chunk's text is ever
 * truncated here: `OllamaEmbeddingProvider` already performs its own
 * bounded sub-batching (by item count AND summed character length) and
 * fails closed (`EMBEDDING_BATCH_INVALID`) if a single item's text alone
 * exceeds its configured per-request character bound -- pre-truncating
 * text in this seam would silently drop source content BEFORE that
 * provider-level bound ever got a chance to reject it outright, exactly
 * the "silent truncation" failure mode this item closes.
 */
export function createProductionNoteEmbeddingSeam(provider: EmbeddingProvider, embeddingModel: string, chunkOptions: { targetTokens: number; overlapTokens: number }): NoteEmbeddingSeam {
  return {
    async embed(projection: SourceProjectionV1, signal: AbortSignal): Promise<EmbeddedNote> {
      const chunks = chunkText(projection.projectedBody, chunkOptions);
      const requestedIds = ["note", ...chunks.map((_chunk, index) => `chunk:${index}`)];
      const items = [{ id: "note", text: projection.projectedBody }, ...chunks.map((chunk, index) => ({ id: `chunk:${index}`, text: chunk }))];
      const batch = await provider.embedBatch({ model: embeddingModel, items }, { signal });

      if (batch.model !== embeddingModel) {
        throw new EngineError("EMBEDDING_MODEL_MISMATCH", "Embedding provider responded with a different model than requested.");
      }
      if (!Number.isInteger(batch.dimension) || batch.dimension <= 0 || batch.dimension > MAX_EMBEDDING_DIMENSION) {
        throw new EngineError("EMBEDDING_DIMENSION_INVALID", "Embedding provider responded with an invalid dimension.");
      }
      assertExactIdSet(requestedIds, batch.items);

      const byId = new Map(batch.items.map((item) => [item.id, item.values] as const));
      const noteValues = byId.get("note");
      assertDenseUnitVector(noteValues, batch.dimension);
      const chunkVectors: Float32Array[] = chunks.map((_chunk, index) => {
        const values = byId.get(`chunk:${index}`);
        assertDenseUnitVector(values, batch.dimension);
        return Float32Array.from(values);
      });
      return { model: batch.model, dimension: batch.dimension, noteVector: Float32Array.from(noteValues), chunkVectors };
    },
  };
}

const MAX_METADATA_CACHE_ENTRIES = 4096;
const MAX_METADATA_CACHE_BYTES = 32_000_000;

interface MetadataNodeCacheEntry {
  key: string;
  prefix: string;
  value: { summary: string; tags: string[]; concepts: string[] };
  bytes: number;
}

function noteIdentityStableKey(identity: import("./contracts").NoteIdentityV1): string {
  return identity.kind === "apple-annotation" ? `apple-annotation:${identity.appleAnnotationId}` : `path:${identity.canonicalPath}`;
}

function metadataCacheKey(identity: import("./contracts").NoteIdentityV1, sourceHash: string, model: string, configFingerprint: string): string {
  return JSON.stringify([noteIdentityStableKey(identity), sourceHash, model, configFingerprint]);
}

function computeConfigFingerprint(config: MetadataPipelineConfig): string {
  const orderedAliases = Object.keys(config.tagAliases).sort().map((key) => [key, config.tagAliases[key]]);
  return JSON.stringify({
    maxTokens: config.maxTokens,
    contextTokens: config.contextTokens ?? null,
    tagLimit: config.tagLimit,
    conceptLimit: config.conceptLimit,
    conceptMaxWords: config.conceptMaxWords,
    conceptCaseMode: config.conceptCaseMode,
    controlledTags: [...config.controlledTags],
    allowFreeTags: config.allowFreeTags,
    tagMinLen: config.tagMinLen,
    tagMaxWords: config.tagMaxWords,
    tagAliases: orderedAliases,
  });
}

/**
 * Production `NoteMetadataSeam` with a bounded in-memory node-result LRU.
 * Completed final outputs are deliberately never cached: every short-note
 * extraction remains a fresh single provider call. Long-path leaf/reduction
 * nodes are retained only across transient failures for their own document.
 */
export function createProductionNoteMetadataSeam(provider: MetadataInferenceProvider, config: MetadataPipelineConfig): NoteMetadataSeam & { clearCache(): void; readonly cacheSize: number } {
  const nodeCache = new Map<string, MetadataNodeCacheEntry>();
  let totalNodeCacheBytes = 0;
  const latestPrefixByIdentity = new Map<string, string>();
  const configFingerprint = computeConfigFingerprint(config);

  function evictOldestNode(): void {
    const oldest = nodeCache.keys().next().value;
    if (oldest === undefined) return;
    const entry = nodeCache.get(oldest);
    if (entry) totalNodeCacheBytes -= entry.bytes;
    nodeCache.delete(oldest);
    prunePrefixRegistry(entry?.prefix);
  }

  function prunePrefixRegistry(prefix: string | undefined): void {
    if (prefix === undefined) return;
    for (const [identity, registeredPrefix] of latestPrefixByIdentity) {
      if (registeredPrefix === prefix && ![...nodeCache.values()].some((entry) => entry.prefix === prefix)) {
        latestPrefixByIdentity.delete(identity);
      }
    }
  }

  function prefixForNodeKey(key: string): string {
    try {
      const parsed: unknown = JSON.parse(key);
      if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
    } catch {
      // Corrupt in-memory keys are not trusted for ownership; isolate them.
    }
    return "invalid-node-prefix";
  }

  function clearPrefix(prefix: string): void {
    for (const [key, entry] of nodeCache) {
      if (entry.prefix === prefix) {
        totalNodeCacheBytes -= entry.bytes;
        nodeCache.delete(key);
      }
    }
  }

  const nodeCacheHook = {
    get(key: string) {
      const entry = nodeCache.get(key);
      if (!entry) return undefined;
      nodeCache.delete(key);
      nodeCache.set(key, entry);
      return entry.value;
    },
    set(key: string, value: { summary: string; tags: string[]; concepts: string[] }) {
      const bytes = Buffer.byteLength(JSON.stringify(value), "utf8") + Buffer.byteLength(key, "utf8");
      const prior = nodeCache.get(key);
      if (prior) totalNodeCacheBytes -= prior.bytes;
      nodeCache.delete(key);
      while (nodeCache.size >= MAX_METADATA_CACHE_ENTRIES || totalNodeCacheBytes + bytes > MAX_METADATA_CACHE_BYTES) {
        if (nodeCache.size === 0) break;
        evictOldestNode();
      }
      nodeCache.set(key, { key, prefix: prefixForNodeKey(key), value, bytes });
      totalNodeCacheBytes += bytes;
    },
    clearPrefix,
    clear() {
      nodeCacheHook.clearAll();
    },
    clearAll() {
      nodeCache.clear();
      totalNodeCacheBytes = 0;
    },
  };

  return {
    async extract(projection: SourceProjectionV1, signal: AbortSignal) {
      const key = metadataCacheKey(projection.identity, projection.sourceHash, config.model, configFingerprint);
      const identityKey = noteIdentityStableKey(projection.identity);
      const priorPrefix = latestPrefixByIdentity.get(identityKey);
      if (priorPrefix !== undefined && priorPrefix !== key) nodeCacheHook.clearPrefix(priorPrefix);
      latestPrefixByIdentity.set(identityKey, key);

      let result: import("./contracts").MetadataOutputV1;
      try {
        result = await runMetadataPipeline(provider, config, { identity: projection.identity, text: projection.projectedBody, related: [] }, {
          signal,
          nodeCache: nodeCacheHook,
          nodeCacheKeyPrefix: key,
        });
      } catch (error) {
        const failureCode = error instanceof EngineError ? error.code : "UNKNOWN_TRANSIENT";
        const cancelled = signal.aborted || failureCode === "METADATA_CANCELLED";
        if (cancelled || classifyFailureCode(failureCode) === "terminal") {
          nodeCacheHook.clearPrefix(key);
          latestPrefixByIdentity.delete(identityKey);
        }
        throw error;
      }
      nodeCacheHook.clearPrefix(key);
      latestPrefixByIdentity.delete(identityKey);
      return result;
    },
    clearCache() {
      nodeCacheHook.clearAll();
      latestPrefixByIdentity.clear();
    },
    get cacheSize() {
      return nodeCache.size;
    },
  };
}
