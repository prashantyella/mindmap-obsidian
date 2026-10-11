import type { LiveRelatedResponse, LiveRelatedResult } from "./semanticTypes";

export const NO_MINDMAP_CONNECTIONS_TITLE = "No mindmap connections";
export const NO_MINDMAP_CONNECTIONS_MESSAGE = "No mindmap connections exist for this note.";

export interface SidebarLiveState {
  path: string;
  status: "idle" | "loading" | "ready" | "error";
  response: LiveRelatedResponse | null;
  error: string | null;
}

export interface MindmapViewState {
  [key: string]: unknown;
  heatmapOpen: boolean;
  expandedByNote: Record<string, string | null>;
}

export function normalizeMindmapViewState(value: unknown): MindmapViewState {
  if (typeof value !== "object" || value === null) return { heatmapOpen: false, expandedByNote: {} };
  const record = value as Record<string, unknown>;
  const entries = typeof record.expandedByNote === "object" && record.expandedByNote !== null
    ? Object.entries(record.expandedByNote as Record<string, unknown>)
      .filter((entry): entry is [string, string | null] => typeof entry[0] === "string" && (typeof entry[1] === "string" || entry[1] === null))
      .slice(-100)
    : [];
  return { heatmapOpen: record.heatmapOpen === true, expandedByNote: Object.fromEntries(entries) };
}

export function rememberExpandedPath(state: MindmapViewState, notePath: string, expandedPath: string | null): MindmapViewState {
  const entries = Object.entries(state.expandedByNote).filter(([path]) => path !== notePath);
  entries.push([notePath, expandedPath]);
  return { ...state, expandedByNote: Object.fromEntries(entries.slice(-100)) };
}

export function getIndexRefreshTargets(activePath: string | null, lookupQuery: string): { live: boolean; lookup: boolean } {
  return { live: activePath !== null, lookup: lookupQuery.trim().length > 0 };
}

export function createIdleLiveState(path: string, response: LiveRelatedResponse | null = null): SidebarLiveState {
  return {
    path,
    status: "idle",
    response,
    error: null,
  };
}

export function createLoadingLiveState(path: string, current: SidebarLiveState): SidebarLiveState {
  return {
    path,
    status: "loading",
    response: current.path === path ? current.response : null,
    error: null,
  };
}

export function createErrorLiveState(path: string, current: SidebarLiveState, error: unknown): SidebarLiveState {
  return {
    path,
    status: "error",
    response: current.path === path ? current.response : null,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function createReadyLiveState(path: string, response: LiveRelatedResponse): SidebarLiveState {
  return {
    path,
    status: "ready",
    response,
    error: null,
  };
}

/**
 * `ensureLiveQuery`'s cache-skip guard: a query already exists for this
 * exact path and hasn't been reset to `"idle"`, so no re-fetch is needed.
 *
 * Deliberately NOT status-aware beyond `"idle"` -- in particular, this
 * does not treat a `"ready"` response with `indexed: false` (e.g. a note
 * queried before migration finished indexing it) as automatically stale.
 * That would make every `render()` call re-issue a query for a note that
 * is still legitimately unindexed, cascading into an unbounded
 * query -> render -> query loop (query resolves indexed:false -> render()
 * -> ensureLiveQuery sees "not fresh" -> queries again -> ...). Invalidating
 * a stale `indexed: false` cache is instead a deliberate, ONE-SHOT action
 * (`MindmapWorkspaceView.invalidateLiveQuery()`, driven by
 * `ProductionEngine.onMigrationComplete`), never an implicit per-render check.
 */
export function shouldSkipLiveQuery(liveState: SidebarLiveState, path: string): boolean {
  return liveState.path === path && liveState.status !== "idle";
}

export function getDisplayLiveRelated(activePath: string, liveState: SidebarLiveState): LiveRelatedResult[] {
  return liveState.path === activePath
    ? liveState.response?.related ?? []
    : [];
}

export function shouldApplyLiveResponse(
  requestId: number,
  latestRequestId: number,
  currentActivePath: string | null,
  requestedPath: string,
): boolean {
  return requestId === latestRequestId && currentActivePath === requestedPath;
}
