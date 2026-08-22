import type { LiveRelatedResponse, LiveRelatedResult } from "./semanticTypes";

export const NO_MINDMAP_CONNECTIONS_TITLE = "No mindmap connections";
export const NO_MINDMAP_CONNECTIONS_MESSAGE = "No mindmap connections exist for this note.";

export interface SidebarLiveState {
  path: string;
  status: "idle" | "loading" | "ready" | "error";
  response: LiveRelatedResponse | null;
  error: string | null;
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
