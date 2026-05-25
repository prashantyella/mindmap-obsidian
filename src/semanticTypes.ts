export type SemanticWorkerMethod =
  | "initialize"
  | "health"
  | "index_paths"
  | "delete_paths"
  | "query_related"
  | "refresh_config"
  | "shutdown";

export interface SemanticWorkerRequest<TParams = Record<string, unknown>> {
  id: string;
  method: SemanticWorkerMethod;
  params: TParams;
}

export interface SemanticWorkerSuccess<TResult = unknown> {
  id: string;
  ok: true;
  result: TResult;
}

export interface SemanticWorkerFailure {
  id: string | null;
  ok: false;
  error: string;
}

export type SemanticWorkerResponse<TResult = unknown> = SemanticWorkerSuccess<TResult> | SemanticWorkerFailure;

export interface SemanticHealth {
  ready: boolean;
  scope: string;
  config_path: string;
  vault_root: string;
  db_path: string;
  embed_model: string;
  llm_model: string;
  allowed_paths: number;
  indexed_notes: number;
  indexed_chunks: number;
}

export interface LiveRelatedResult {
  path: string;
  score: number;
  kind: "core" | "overreach" | "creative" | "fill";
  title?: string;
  stale?: boolean;
}

export interface LiveRelatedResponse {
  path: string;
  hash: string;
  indexed: boolean;
  stale: boolean;
  index_result: unknown | null;
  related: LiveRelatedResult[];
}

export interface IndexPathsResponse {
  indexed: number;
  results: unknown[];
}

export interface DeletePathsResponse {
  deleted: number;
  results: unknown[];
}
