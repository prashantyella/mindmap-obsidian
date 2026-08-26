import type { BulkBatchV1, PersistedJobV1, ProviderPauseV1 } from "./jobTypes";

export type EngineActivityState = "idle" | "running" | "paused" | "faulted" | "stopped";

export interface EngineActivitySnapshot {
  state: EngineActivityState;
  queuedCount: number;
  activeCount: number;
  processNoteCount: number;
  bulkBlocked: boolean;
  current?: { kind: PersistedJobV1["job"]["kind"]; phase: string; path?: string; attempt: number };
  providerPause?: string;
  fault?: string;
  batch?: { status: BulkBatchV1["status"]; processed: number; total?: number; failed: number };
  latestFailureBatch?: { status: BulkBatchV1["status"]; failed: number };
}

export function deriveEngineActivity(jobs: readonly PersistedJobV1[], batches: readonly BulkBatchV1[], pause: ProviderPauseV1, pumpEnabled: boolean, disposed: boolean, fault: string | undefined): EngineActivitySnapshot {
  const active = jobs.find((job) => job.status === "active");
  const queued = jobs.filter((job) => job.status === "queued");
  const batch = batches.find((entry) => entry.status === "active");
  const terminal = [...batches].filter((entry) => entry.status === "completed-with-failures" || entry.status === "failed" || entry.status === "cancelled").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const activityBatch = batch ? { status: batch.status, processed: batch.items.filter((item) => item.status === "completed" || item.status === "failed" || item.status === "cancelled").length, total: batch.discoveredTotal, failed: batch.items.filter((item) => item.status === "failed" || item.status === "cancelled").length } : undefined;
  const current = active ?? queued[0];
  const path = current?.job.target.kind === "note" && current.job.target.identity.kind === "path" ? current.job.target.identity.canonicalPath.split("/").pop() : undefined;
  const processNoteCount = jobs.filter((job) => job.job.kind === "process-note" && (job.status === "queued" || job.status === "active")).length;
  return { state: fault ? "faulted" : pause.active ? "paused" : disposed || !pumpEnabled ? "stopped" : active || queued.length || batch ? "running" : "idle", queuedCount: queued.length, activeCount: active ? 1 : 0, processNoteCount, bulkBlocked: batch !== undefined || jobs.some((job) => (job.job.kind === "scope-refresh" || job.job.kind === "rebuild-index") && (job.status === "queued" || job.status === "active")), current: current ? { kind: current.job.kind, phase: current.job.phase, path, attempt: current.attempt } : undefined, providerPause: pause.code, fault, batch: activityBatch, latestFailureBatch: terminal ? { status: terminal.status, failed: terminal.items.filter((item) => item.status === "failed" || item.status === "cancelled").length } : undefined };
}
