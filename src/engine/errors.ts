/**
 * The closed, exhaustive list of every code `EngineError` can carry. Defined
 * as a runtime array FIRST (with `EngineErrorCode` derived from it via
 * `typeof[number]`), not as a bare type union, so a runtime allow-list
 * (e.g. the job-failure-code redaction in `jobTypes.ts`'s `toFailureCode`/
 * `sanitizeFailureCode`) can enumerate exactly these values without a
 * separate list that could drift out of sync with the type.
 */
export const ENGINE_ERROR_CODES = [
  "CONTRACT_SCHEMA_VERSION_MISSING",
  "CONTRACT_SCHEMA_VERSION_MISMATCH",
  "CONTRACT_SHAPE_INVALID",
  "PATH_EMPTY",
  "PATH_ABSOLUTE",
  "PATH_TRAVERSAL",
  "PATH_CONTROL_CHARACTER",
  "IDENTITY_INVALID",
  "FRONTMATTER_MALFORMED",
  "SOURCE_STALE",
  "STORE_PATH_INVALID",
  "STORE_READ_FAILED",
  "STORE_WRITE_FAILED",
  "STORE_SCHEMA_INVALID",
  "VAULT_WRITE_FAILED",
  "EMBEDDING_ENDPOINT_INVALID",
  "EMBEDDING_BATCH_INVALID",
  "EMBEDDING_CANCELLED",
  "EMBEDDING_TIMEOUT",
  "EMBEDDING_REQUEST_FAILED",
  "EMBEDDING_MODEL_NOT_FOUND",
  "EMBEDDING_RESPONSE_INVALID",
  "EMBEDDING_MODEL_MISMATCH",
  "EMBEDDING_COUNT_MISMATCH",
  "EMBEDDING_DIMENSION_MISMATCH",
  "EMBEDDING_DIMENSION_INVALID",
  "EMBEDDING_VECTOR_INVALID",
  "EMBEDDING_RESPONSE_TOO_LARGE",
  "EMBEDDING_TIMER_FAILED",
  "CHUNK_INPUT_INVALID",
  "METADATA_PROMPT_TOO_LARGE",
  "METADATA_RESPONSE_TOO_LARGE",
  "METADATA_RESPONSE_INVALID",
  "METADATA_CONFIG_INVALID",
  "METADATA_PROVIDER_FAILED",
  "METADATA_ENDPOINT_INVALID",
  "METADATA_CANCELLED",
  "METADATA_TIMEOUT",
  "JOB_SHAPE_INVALID",
  "JOB_TRANSITION_INVALID",
  "JOB_STORE_CORRUPT",
  "JOB_CAP_EXCEEDED",
  "JOB_CANCELLED",
  "JOB_NOT_FOUND",
  "REBUILD_SUPERSEDED",
  "GENERATION_ARTIFACT_MISMATCH",
  "SCOPE_SUPERSEDED",
  "SCHEDULE_SHAPE_INVALID",
  "SCHEDULE_STORE_CORRUPT",
  "SCHEDULE_NOT_FOUND",
  "SCHEDULE_CAP_EXCEEDED",
  "SCHEDULE_TRANSITION_INVALID",
  "TIMEZONE_INVALID",
  "LAUNCH_AGENT_INVALID",
  "LAUNCH_AGENT_WRITE_FAILED",
  "LAUNCH_AGENT_OWNERSHIP_CONFLICT",
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: EngineErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.context = context;
  }
}

export function isEngineError(value: unknown): value is EngineError {
  return value instanceof EngineError;
}
