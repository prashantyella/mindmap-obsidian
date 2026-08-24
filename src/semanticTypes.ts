export interface LiveRelatedResult {
  path: string;
  score: number;
  kind: "core" | "overreach" | "creative" | "fill" | "lookup";
  title?: string;
  stale?: boolean;
}

export interface LiveRelatedResponse {
  path: string;
  hash: string;
  indexed: boolean;
  stale: boolean;
  index_result: unknown;
  related: LiveRelatedResult[];
}

export interface LookupRelatedResponse {
  query: string;
  related: LiveRelatedResult[];
}
