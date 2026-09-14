import { isTerminalJobStatus, type BulkBatchV1, type PersistedJobV1, type ProviderPauseV1 } from "./jobTypes";
import { EngineError } from "../engine/errors";

export type EngineActivityState = "idle" | "running" | "paused" | "operator-paused" | "faulted" | "stopped";

export interface EngineActivitySnapshot {
  state: EngineActivityState;
  queuedCount: number;
  activeCount: number;
  processNoteCount: number;
  bulkBlocked: boolean;
  current?: { kind: PersistedJobV1["job"]["kind"]; phase: string; path?: string; attempt: number };
  providerPause?: string;
  operatorPause?: boolean;
  fault?: string;
  batch?: { status: BulkBatchV1["status"]; preparing: boolean; processed: number; total?: number; failed: number; enqueuedCount?: number };
  latestFailureBatch?: { status: BulkBatchV1["status"]; failed: number };
}

export function deriveEngineActivity(jobs: readonly PersistedJobV1[], batches: readonly BulkBatchV1[], pause: ProviderPauseV1, operatorPause: { active: boolean; pausedAt?: string }, pumpEnabled: boolean, disposed: boolean, fault: string | undefined): EngineActivitySnapshot {
  const active = jobs.find((job) => job.status === "active");
  const queued = jobs.filter((job) => job.status === "queued");
  const batch = batches.find((entry) => entry.status === "active");
  const terminal = [...batches].filter((entry) => entry.status === "completed-with-failures" || entry.status === "failed" || entry.status === "cancelled").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  let activityBatch: EngineActivitySnapshot["batch"];
  if (batch) {
    const rootJob = jobs.find((j) => j.job.jobId === batch.rootJobId);
    if (!rootJob) throw new EngineError("JOB_STORE_CORRUPT", "Active batch root job missing from jobs array.", {});
    const preparing = !isTerminalJobStatus(rootJob.status);
    const rootReceipt = rootJob?.receipt?.kind === "scope" ? rootJob.receipt : undefined;
    const enqueuedCount = rootReceipt?.enqueuedCount;
    const terminalChildren = batch.items.filter((item) => isTerminalJobStatus(item.status)).length;
    const skipped = !preparing && enqueuedCount !== undefined && batch.discoveredTotal !== undefined ? batch.discoveredTotal - enqueuedCount : 0;
    activityBatch = { status: batch.status, preparing, processed: skipped + terminalChildren, total: batch.discoveredTotal, failed: batch.items.filter((item) => item.status === "failed" || item.status === "cancelled").length, enqueuedCount };
  }
  const current = active ?? queued[0];
  const path = current?.job.target.kind === "note" && current.job.target.identity.kind === "path" ? current.job.target.identity.canonicalPath.split("/").pop() : undefined;
  const processNoteCount = jobs.filter((job) => job.job.kind === "process-note" && (job.status === "queued" || job.status === "active")).length;
  return { state: fault ? "faulted" : operatorPause.active ? "operator-paused" : pause.active ? "paused" : disposed || !pumpEnabled ? "stopped" : active || queued.length || batch ? "running" : "idle", queuedCount: queued.length, activeCount: active ? 1 : 0, processNoteCount, bulkBlocked: batch !== undefined || jobs.some((job) => (job.job.kind === "scope-refresh" || job.job.kind === "rebuild-index") && (job.status === "queued" || job.status === "active")), current: current ? { kind: current.job.kind, phase: current.job.phase, path, attempt: current.attempt } : undefined, providerPause: pause.code, operatorPause: operatorPause.active, fault, batch: activityBatch, latestFailureBatch: terminal ? { status: terminal.status, failed: terminal.items.filter((item) => item.status === "failed" || item.status === "cancelled").length } : undefined };
}
