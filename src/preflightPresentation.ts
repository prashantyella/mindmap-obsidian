import type { PreflightResult, PreflightCheck } from "./diagnostics";
import type { PreflightReportV1 } from "./engine/preflight";

const LABELS: Record<string, string> = {
  VAULT_ADAPTER: "Vault access", OWNED_DATA_PATHS: "Plugin data", JOB_STORE: "Processing queue",
  SCHEDULE_STORE: "Schedule storage", INDEX_STORE: "Connection index", TEMP_CLEANUP: "Temporary files",
  OLLAMA_EMBEDDINGS: "Embedding model", LOCAL_METADATA_PROVIDER: "Summaries and tags model",
  APPLE_BOOKS_READING: "Apple Books import", RESEARCH_PROVIDER: "Web research", BACKGROUND_SCHEDULER: "Scheduled opening",
};
const PROCESSING_CHECKS = new Set(["VAULT_ADAPTER", "OWNED_DATA_PATHS", "JOB_STORE", "SCHEDULE_STORE", "INDEX_STORE", "TEMP_CLEANUP", "OLLAMA_EMBEDDINGS", "LOCAL_METADATA_PROVIDER"]);
const GUIDANCE: Record<string, string> = {
  OLLAMA_EMBEDDINGS: "Start Ollama and check the embedding model in Local AI settings.",
  LOCAL_METADATA_PROVIDER: "Start Ollama and check the summaries and tags model in Local AI settings.",
};

export function presentPreflight(report: PreflightReportV1, migrationReady = true): PreflightResult {
  const checks: PreflightCheck[] = report.checks.map((check) => ({
    code: check.code, label: LABELS[check.code] ?? check.code,
    status: check.status === "ok" ? "ok" : !PROCESSING_CHECKS.has(check.code) && check.message === "Capability is not configured." ? "skipped" : "error",
    message: check.message, guidance: check.guidance ?? GUIDANCE[check.code], context: check.context,
  }));
  const blocked = checks.find((check) => PROCESSING_CHECKS.has(check.code) && check.status !== "ok");
  const modelsChecked = ["OLLAMA_EMBEDDINGS", "LOCAL_METADATA_PROVIDER"].every((code) => checks.some((check) => check.code === code && check.status === "ok"));
  let summary: string;
  const ok = report.summary.runtimeReady && !blocked && modelsChecked && migrationReady;
  if (blocked) summary = `${blocked.label} is not ready. ${blocked.guidance ?? blocked.message}`;
  else if (!modelsChecked || !report.summary.runtimeReady) summary = "Setup checks could not confirm that note processing is ready. Check setup again.";
  else if (!migrationReady) summary = "Local models are ready. Finish index setup from the Mindmap status menu before processing notes.";
  else {
    const warnings = checks.filter((check) => !PROCESSING_CHECKS.has(check.code) && check.status === "error");
    summary = warnings.length ? `Note processing is ready. ${warnings.map((check) => check.label).join(", ")} needs attention.` : "Local models and connection index are ready for note processing.";
  }
  return { ok, summary, checks, rawStdout: "", rawStderr: "", exitCode: ok ? 0 : 1 };
}
