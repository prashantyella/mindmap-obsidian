import type { LiveRelatedResponse, LiveRelatedResult } from "./semanticTypes";

export const NO_MINDMAP_CONNECTIONS_TITLE = "No mindmap connections";
export const NO_MINDMAP_CONNECTIONS_MESSAGE = "No mindmap connections exist for this note.";

export interface SidebarLiveState {
  path: string;
  status: "idle" | "loading" | "ready" | "error";
  response: LiveRelatedResponse | null;
  displayResponse?: LiveRelatedResponse | null;
  error: string | null;
}

export interface MindmapViewState {
  [key: string]: unknown;
  collapsedByNote: Record<string, string[]>;
}

export function normalizeMindmapViewState(value: unknown): MindmapViewState {
  if (typeof value !== "object" || value === null) return { collapsedByNote: {} };
  const record = value as Record<string, unknown>;
  const entries = typeof record.collapsedByNote === "object" && record.collapsedByNote !== null
    ? Object.entries(record.collapsedByNote as Record<string, unknown>)
      .filter((entry): entry is [string, string[]] => typeof entry[0] === "string" && Array.isArray(entry[1]))
      .map(([path, collapsed]) => [path, [...new Set(collapsed.filter((candidate): candidate is string => typeof candidate === "string"))]] as [string, string[]])
      .slice(-100)
    : [];
  // Legacy expandedByNote state represented a single-open accordion. Ignore
  // it so upgrading makes every summary readable by default.
  return { collapsedByNote: Object.fromEntries(entries) };
}

export function rememberCollapsedPaths(state: MindmapViewState, notePath: string, collapsedPaths: Iterable<string>): MindmapViewState {
  const entries = Object.entries(state.collapsedByNote).filter(([path]) => path !== notePath);
  entries.push([notePath, [...new Set(collapsedPaths)]]);
  return { ...state, collapsedByNote: Object.fromEntries(entries.slice(-100)) };
}

export function toggleCollapsedPaths(current: ReadonlySet<string>, path: string, allPaths: readonly string[], toggleAll: boolean): Set<string> {
  const next = new Set(current);
  const collapsing = !next.has(path);
  if (toggleAll) return collapsing ? new Set(allPaths) : new Set();
  if (collapsing) next.add(path);
  else next.delete(path);
  return next;
}

export function getIndexRefreshTargets(activePath: string | null, lookupQuery: string): { live: boolean; lookup: boolean } {
  return { live: activePath !== null, lookup: lookupQuery.trim().length > 0 };
}

export function createIdleLiveState(path: string, response: LiveRelatedResponse | null = null, displayResponse: LiveRelatedResponse | null = response, error: string | null = null): SidebarLiveState {
  return {
    path,
    status: "idle",
    response,
    displayResponse,
    error,
  };
}

export function createLoadingLiveState(path: string, current: SidebarLiveState): SidebarLiveState {
  return {
    path,
    status: "loading",
    response: current.path === path ? current.response : null,
    displayResponse: current.path === path ? current.displayResponse ?? current.response : null,
    error: current.path === path ? current.error : null,
  };
}

export function createErrorLiveState(path: string, current: SidebarLiveState, error: unknown): SidebarLiveState {
  return {
    path,
    status: "error",
    response: current.path === path ? current.response : null,
    displayResponse: current.path === path ? current.displayResponse ?? current.response : null,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function createReadyLiveState(path: string, response: LiveRelatedResponse, current?: SidebarLiveState): SidebarLiveState {
  return {
    path,
    status: "ready",
    response,
    displayResponse: response.indexed && (!response.stale || response.related.length > 0)
      ? response
      : current?.path === path ? current.displayResponse ?? current.response : null,
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
    ? (liveState.displayResponse ?? liveState.response)?.related ?? []
    : [];
}

/** Pending indexing is not evidence of an empty result. Background refreshes keep accepted feedback. */
export function getLiveFeedback(state: SidebarLiveState, liveEnabled: boolean): "none" | "empty" | "error" {
  if (!liveEnabled) return "empty";
  if (state.error !== null) return "error";
  const response = state.displayResponse ?? state.response;
  return response?.indexed && !response.stale && response.related.length === 0 ? "empty" : "none";
}

export function shouldApplyLiveResponse(
  requestId: number,
  latestRequestId: number,
  currentActivePath: string | null,
  requestedPath: string,
): boolean {
  return requestId === latestRequestId && currentActivePath === requestedPath;
}
