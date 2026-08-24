import {
  BUDGET_DISK_BYTES,
  BUDGET_REBUILD_PEAK_MEMORY_BYTES,
  BUDGET_STEADY_STATE_MEMORY_BYTES,
  computeDiskBytes,
  computeRebuildPeakBytes,
  computeSteadyStateBytes,
} from "./budgets";
import { encodedMatrixByteLength, MAX_DIMENSION, MAX_MATRIX_TOTAL_BYTES, VECTOR_MATRIX_SCHEMA_VERSION } from "./vectorCodec";
import type { ChunkShardManifestEntryV1, EmbeddingProviderId, VectorIndexManifestV1 } from "./vectorTypes";

/**
 * Strict, fail-closed parser for `VectorIndexManifestV1` -- the single
 * source of truth for "what embedding provider/model/dimension/codec
 * version was this index generation built with, and how many
 * notes/chunks/shards does it cover." Never reinterprets an unknown or
 * malformed manifest; every mismatch throws `IndexManifestError` rather
 * than silently defaulting a field. No filesystem access here -- this
 * module only ever validates an already-parsed JSON value; Checkpoint 5
 * owns reading/writing the manifest file itself.
 */

export class IndexManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexManifestError";
  }
}

const MANIFEST_SCHEMA_VERSION = 1;
/** Exactly one codec version is ever accepted -- this manifest format has no forward-compat story, so a manifest that claims any other version is rejected outright rather than accepted within a range. */
const SUPPORTED_CODEC_VERSION = VECTOR_MATRIX_SCHEMA_VERSION;
const SUPPORTED_EMBEDDING_PROVIDERS: ReadonlySet<string> = new Set<EmbeddingProviderId>(["ollama"]);
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
/** Bounded well beyond the design's target scale so a corrupt/adversarial manifest can never claim an implausible generation count. */
const MAX_GENERATION_ID = Number.MAX_SAFE_INTEGER;
/**
 * Committed-generation ceilings set to the approved design target EXACTLY
 * (10,000 notes / 100,000 chunks), not a multiple of it -- a manifest is
 * only ever describing an already-committed generation, so anything beyond
 * the approved target is not a plausible committed generation and fails
 * closed rather than being tolerated as "not yet over some looser bound".
 */
export const MAX_MANIFEST_NOTE_COUNT = 10_000;
export const MAX_MANIFEST_CHUNK_COUNT = 100_000;
/**
 * A single resident decoded shard is part of the steady-state memory
 * budget alongside the note matrix (see `benchmark.test.ts`): at the
 * design's TARGET dimension (1,024), 10,000 rows leaves real headroom
 * inside the approved 128MB steady-state budget. This per-shard row cap
 * is NOT sufficient on its own at a larger declared dimension -- 10,000
 * rows at `MAX_DIMENSION` (8,192) alone is ~327MB, already far past
 * 128MB. The combined `computeSteadyStateBytes`/`computeRebuildPeakBytes`/
 * `computeDiskBytes` helpers in `budgets.ts` (enforced below, after
 * `dimension` is known) are the AUTHORITATIVE, dimension-aware budget
 * check; this row cap is a cheap, dimension-independent additional bound,
 * not a substitute for it.
 */
export const MAX_MANIFEST_SHARD_ROW_COUNT = 10_000;
/** A manifest can never declare more shards than there are chunks to distribute among them (each shard must have at least 1 row), so this is tied to `MAX_MANIFEST_CHUNK_COUNT` rather than an independent, looser constant. */
const MAX_SHARD_COUNT = MAX_MANIFEST_CHUNK_COUNT;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Codepoint-by-codepoint control-character check -- deliberately NOT a
 * regex literal containing an actual control byte (e.g. `/[\x00-\x1f]/`
 * can end up with a literal NUL/ESC/DEL byte embedded in the compiled
 * source depending on the toolchain that touches the file), so this file
 * itself can never regress into shipping a literal control byte. Matches
 * the C0 control range (0x00-0x1F) and DEL (0x7F).
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new IndexManifestError(`${field} must be an integer in [${min}, ${max}].`);
  }
  return value;
}

/** Requires a non-empty, control-character-free string and returns it trimmed -- identifiers/model names are normalized to their trimmed form so two entries differing only in surrounding whitespace are treated as the same identity. */
function requireNormalizedIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new IndexManifestError(`${field} must be a string.`);
  }
  if (hasControlCharacter(value)) {
    throw new IndexManifestError(`${field} must not contain control characters.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new IndexManifestError(`${field} must be a non-empty string.`);
  }
  return trimmed;
}

function requireHex64(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX_64_PATTERN.test(value)) {
    throw new IndexManifestError(`${field} must be a 64-character lowercase hex SHA-256 digest.`);
  }
  return value;
}

/**
 * Requires exactly the canonical `Date.prototype.toISOString()` form and
 * round-trips the value to catch a calendar-normalized impossible date
 * (e.g. "2026-02-30" silently becoming "2026-03-02") rather than accepting
 * it on a regex shape check alone.
 */
function requireIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new IndexManifestError(`${field} must be a string.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new IndexManifestError(`${field} must be a real UTC ISO-8601 timestamp in canonical toISOString() form.`);
  }
  return value;
}

function assertFitsMatrixByteBudget(dimension: number, count: number, field: string): void {
  const bytes = encodedMatrixByteLength(dimension, count);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_MATRIX_TOTAL_BYTES) {
    throw new IndexManifestError(
      `${field} declares a shape (dimension=${dimension}, count=${count}) that cannot fit within the ${MAX_MATRIX_TOTAL_BYTES}-byte encoded-matrix budget.`,
    );
  }
}

function parseChunkShardEntry(value: unknown, index: number, dimension: number): ChunkShardManifestEntryV1 {
  if (!isRecord(value)) {
    throw new IndexManifestError(`chunkShards[${index}] must be an object.`);
  }
  if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new IndexManifestError(`chunkShards[${index}].schemaVersion must be ${MANIFEST_SCHEMA_VERSION}.`);
  }
  // Nonempty shards must declare a strictly positive count, bounded at MAX_MANIFEST_SHARD_ROW_COUNT
  // -- a zero-count shard entry is meaningless, and a shard beyond the per-shard cap could never be
  // kept resident within the steady-state memory budget even though the codec's own 512MB ceiling
  // would otherwise permit it.
  const count = requireInteger(value.count, `chunkShards[${index}].count`, 1, MAX_MANIFEST_SHARD_ROW_COUNT);
  assertFitsMatrixByteBudget(dimension, count, `chunkShards[${index}]`);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    shardId: requireNormalizedIdentifier(value.shardId, `chunkShards[${index}].shardId`),
    count,
    checksum: requireHex64(value.checksum, `chunkShards[${index}].checksum`),
    offsetChecksum: requireHex64(value.offsetChecksum, `chunkShards[${index}].offsetChecksum`),
  };
}

/**
 * Parses and strictly validates an already-JSON-parsed manifest value.
 * Fails closed (throws `IndexManifestError`) on: a missing/mismatched
 * `schemaVersion`, an unsupported `embeddingProvider`, an out-of-bound
 * `dimension`/`noteCount`/`chunkCount`/`generationId`, a `codecVersion`
 * other than the exactly-one supported codec version, a malformed checksum
 * or timestamp, an identifier containing control characters, a duplicate
 * `shardId` (after normalization), a nonempty shard with a non-positive or
 * over-cap `count`, a nonzero `chunkCount` with zero shards (or vice
 * versa), any shard whose declared `count` doesn't sum consistently with
 * `chunkCount`, any declared dimension/count whose encoded matrix could
 * not fit within the codec's byte budget, a shape whose computed
 * steady-state/rebuild-peak/disk byte accounting (see `budgets.ts`)
 * exceeds the approved 128MB/512MB/600MB budgets, or a missing/malformed
 * `noteMetadataChecksum`/per-shard `offsetChecksum`.
 */
export function parseVectorIndexManifestV1(value: unknown): VectorIndexManifestV1 {
  if (!isRecord(value)) {
    throw new IndexManifestError("manifest must be a JSON object.");
  }
  if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new IndexManifestError(`manifest.schemaVersion must be ${MANIFEST_SCHEMA_VERSION}; got ${String(value.schemaVersion)}.`);
  }
  const generationId = requireInteger(value.generationId, "manifest.generationId", 0, MAX_GENERATION_ID);
  const generationCreatedAt = requireIsoTimestamp(value.generationCreatedAt, "manifest.generationCreatedAt");

  if (typeof value.embeddingProvider !== "string" || !SUPPORTED_EMBEDDING_PROVIDERS.has(value.embeddingProvider)) {
    throw new IndexManifestError(`manifest.embeddingProvider must be one of: ${[...SUPPORTED_EMBEDDING_PROVIDERS].join(", ")}.`);
  }
  const embeddingProvider = value.embeddingProvider as EmbeddingProviderId;
  const embeddingModel = requireNormalizedIdentifier(value.embeddingModel, "manifest.embeddingModel");
  const dimension = requireInteger(value.dimension, "manifest.dimension", 1, MAX_DIMENSION);
  const noteCount = requireInteger(value.noteCount, "manifest.noteCount", 0, MAX_MANIFEST_NOTE_COUNT);
  const chunkCount = requireInteger(value.chunkCount, "manifest.chunkCount", 0, MAX_MANIFEST_CHUNK_COUNT);
  if (value.codecVersion !== SUPPORTED_CODEC_VERSION) {
    throw new IndexManifestError(`manifest.codecVersion must be exactly ${SUPPORTED_CODEC_VERSION}; got ${String(value.codecVersion)}.`);
  }
  const codecVersion = SUPPORTED_CODEC_VERSION;
  const noteMatrixChecksum = requireHex64(value.noteMatrixChecksum, "manifest.noteMatrixChecksum");
  const noteMetadataChecksum = requireHex64(value.noteMetadataChecksum, "manifest.noteMetadataChecksum");
  assertFitsMatrixByteBudget(dimension, noteCount, "manifest note matrix");

  if (!Array.isArray(value.chunkShards)) {
    throw new IndexManifestError("manifest.chunkShards must be an array.");
  }
  if (value.chunkShards.length > MAX_SHARD_COUNT) {
    throw new IndexManifestError(`manifest.chunkShards has ${value.chunkShards.length} entries, exceeding the bound of ${MAX_SHARD_COUNT}.`);
  }
  if (chunkCount === 0 && value.chunkShards.length !== 0) {
    throw new IndexManifestError("manifest.chunkShards must be empty when manifest.chunkCount is 0.");
  }
  if (chunkCount > 0 && value.chunkShards.length === 0) {
    throw new IndexManifestError("manifest.chunkShards must be nonempty when manifest.chunkCount is greater than 0.");
  }
  const chunkShards = value.chunkShards.map((entry, index) => parseChunkShardEntry(entry, index, dimension));
  const shardIds = new Set<string>();
  let shardChunkTotal = 0;
  for (const shard of chunkShards) {
    if (shardIds.has(shard.shardId)) {
      throw new IndexManifestError(`manifest.chunkShards has a duplicate shardId (after normalization): "${shard.shardId}".`);
    }
    shardIds.add(shard.shardId);
    shardChunkTotal += shard.count;
  }
  if (shardChunkTotal !== chunkCount) {
    throw new IndexManifestError(
      `manifest.chunkShards' counts sum to ${shardChunkTotal}, which does not match manifest.chunkCount (${chunkCount}).`,
    );
  }

  // The approved memory/disk budgets are executable invariants of a committed generation, not
  // just benchmark-only aspirations -- a manifest that would require more than the budget to
  // load/query/store is rejected here, the same way any other out-of-range field is. These use
  // the exact same constants/helpers `benchmark.test.ts` asserts its own byte accounting against
  // (see `budgets.ts`), so the parser and the benchmark can never drift apart.
  const largestShardCount = chunkShards.reduce((max, shard) => Math.max(max, shard.count), 0);
  const steadyStateBytes = computeSteadyStateBytes({ dimension, noteCount, largestShardCount });
  if (steadyStateBytes > BUDGET_STEADY_STATE_MEMORY_BYTES) {
    throw new IndexManifestError(
      `manifest declares a shape whose steady-state memory (${steadyStateBytes} bytes) exceeds the approved ${BUDGET_STEADY_STATE_MEMORY_BYTES}-byte budget.`,
    );
  }
  const rebuildPeakBytes = computeRebuildPeakBytes({ dimension, noteCount, largestShardCount });
  if (rebuildPeakBytes > BUDGET_REBUILD_PEAK_MEMORY_BYTES) {
    throw new IndexManifestError(
      `manifest declares a shape whose rebuild-peak memory (${rebuildPeakBytes} bytes) exceeds the approved ${BUDGET_REBUILD_PEAK_MEMORY_BYTES}-byte budget.`,
    );
  }
  const diskBytes = computeDiskBytes(
    dimension,
    noteCount,
    chunkShards.map((shard) => shard.count),
  );
  if (diskBytes > BUDGET_DISK_BYTES) {
    throw new IndexManifestError(`manifest declares a shape whose disk usage (${diskBytes} bytes) exceeds the approved ${BUDGET_DISK_BYTES}-byte budget.`);
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generationId,
    generationCreatedAt,
    embeddingProvider,
    embeddingModel,
    dimension,
    noteCount,
    chunkCount,
    codecVersion,
    noteMatrixChecksum,
    noteMetadataChecksum,
    chunkShards,
  };
}
