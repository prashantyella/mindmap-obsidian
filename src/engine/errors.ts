export type EngineErrorCode =
  | "CONTRACT_SCHEMA_VERSION_MISSING"
  | "CONTRACT_SCHEMA_VERSION_MISMATCH"
  | "CONTRACT_SHAPE_INVALID"
  | "PATH_EMPTY"
  | "PATH_ABSOLUTE"
  | "PATH_TRAVERSAL"
  | "PATH_CONTROL_CHARACTER"
  | "IDENTITY_INVALID";

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
