import type { AppleBooksReadResult, AppleBooksReadStatus } from "../reading/appleBooksSqlite";
import type { BackgroundReconcileStatus } from "../scheduling/backgroundScheduler";
import type { MetadataInferenceProvider } from "./metadataPipeline";
import type { EmbeddingProvider } from "./embeddingProvider";
import type { PreflightProbe, PreflightProbeResult } from "./preflight";

/**
 * Concrete, fake-testable preflight probe FACTORIES for every optional
 * capability `MindmapEngine` does not own the implementation of
 * (Checkpoint 9 requirement 6). Each factory takes an already-composed,
 * narrow, read-only-by-contract seam (an `EmbeddingProvider`, a
 * `MetadataInferenceProvider`, an `AppleBooksSqliteReader.checkAccess`-
 * shaped reader, an injected credential-readiness boolean, or a
 * `BackgroundScheduler.status`-shaped status source) and returns a
 * `PreflightProbe` that:
 *
 * - sends a fixed, benign, non-secret, non-note-content probe input (never
 *   real vault text, never a caller-supplied arbitrary string);
 * - relies on the bounded per-check timeout/cancellation `runPreflight`'s
 *   `boundedCheck` already imposes around every probe (see `preflight.ts`)
 *   -- a probe here never adds a second, competing timeout;
 * - returns only a CLOSED, centrally-owned static message per detail code
 *   -- never a raw thrown error/message, provider response body, endpoint
 *   URL, file path, or credential value;
 * - carries only a small, enum/boolean/numeric `context` (further bounded
 *   and key-pattern-redacted by `preflight.ts`'s own `redactContext`).
 */

const DETAIL_MESSAGES = {
  OLLAMA_READY: "Ollama embedding endpoint responded to a bounded readiness probe.",
  OLLAMA_UNREACHABLE: "Ollama embedding endpoint did not respond to a bounded readiness probe.",
  LOCAL_METADATA_READY: "Local metadata inference endpoint responded to a bounded readiness probe.",
  LOCAL_METADATA_UNREACHABLE: "Local metadata inference endpoint did not respond to a bounded readiness probe.",
  APPLE_BOOKS_READY: "Apple Books source is readable.",
  APPLE_BOOKS_DEGRADED: "Apple Books source is reachable but reported a non-fatal status.",
  APPLE_BOOKS_UNAVAILABLE: "Apple Books source is not readable.",
  RESEARCH_CREDENTIAL_READY: "Web research credential is present in Keychain.",
  RESEARCH_CREDENTIAL_MISSING: "Web research credential is not configured in Keychain.",
  RESEARCH_CREDENTIAL_CHECK_FAILED: "Web research credential readiness could not be determined.",
  BACKGROUND_SCHEDULER_INSTALLED: "Background scheduler LaunchAgent is installed and loaded.",
  BACKGROUND_SCHEDULER_NOT_CONFIGURED: "Background scheduler LaunchAgent is not installed.",
  BACKGROUND_SCHEDULER_UNSUPPORTED: "Background scheduler is not supported on this platform.",
  BACKGROUND_SCHEDULER_CONFLICT: "Background scheduler LaunchAgent reported a conflicting or ambiguous state.",
  BACKGROUND_SCHEDULER_CHECK_FAILED: "Background scheduler status could not be determined.",
} as const;

type DetailCode = keyof typeof DETAIL_MESSAGES;

function result(status: PreflightProbeResult["status"], code: DetailCode, context?: Record<string, unknown>): PreflightProbeResult {
  return { status, message: DETAIL_MESSAGES[code], context: { detailCode: code, ...context } };
}

/** Fixed, benign, non-secret probe input -- never real note/vault content. */
const PROBE_TEXT = "mindmap-preflight-probe";
const PROBE_ITEM_ID = "preflight";

export interface OllamaEmbeddingProbeConfig {
  /** The configured model name; compared against the probe response's own `model`/`dimension`, never forwarded raw into the report. */
  model: string;
  /** Expected embedding dimension, when known; a mismatch degrades rather than fails, since a model swap is a configuration concern, not an outage. */
  expectedDimension?: number;
}

/**
 * Wraps an already-composed `EmbeddingProvider` (loopback-endpoint
 * validation already happened at construction time -- see
 * `OllamaEmbeddingProvider`'s constructor / `validateOllamaEndpoint`).
 * Embeds exactly one fixed benign string and validates the response shape
 * and dimension bound; the vector VALUES themselves are never read into
 * the report, only `dimension` (a small bounded integer).
 */
export function createOllamaEmbeddingReadinessProbe(provider: EmbeddingProvider, config: OllamaEmbeddingProbeConfig): PreflightProbe {
  return async (signal: AbortSignal): Promise<PreflightProbeResult> => {
    try {
      const batch = await provider.embedBatch({ model: config.model, items: [{ id: PROBE_ITEM_ID, text: PROBE_TEXT }] }, { signal });
      if (batch.items.length !== 1 || !Number.isInteger(batch.dimension) || batch.dimension <= 0) {
        return result("unavailable", "OLLAMA_UNREACHABLE");
      }
      if (config.expectedDimension !== undefined && batch.dimension !== config.expectedDimension) {
        return result("degraded", "OLLAMA_READY", { dimension: batch.dimension, expectedDimension: config.expectedDimension });
      }
      return result("ok", "OLLAMA_READY", { dimension: batch.dimension });
    } catch {
      // Never forward the raw thrown error/message -- see this module's doc comment.
      return result("unavailable", "OLLAMA_UNREACHABLE");
    }
  };
}

/**
 * Wraps an already-composed `MetadataInferenceProvider` (loopback-endpoint
 * validation already happened at construction time). Sends one fixed
 * benign chat message ("respond with the single word ready") with a small
 * bounded `maxTokens` and only checks that SOME non-blank content came
 * back -- the response content itself is never read into the report.
 */
export function createLocalMetadataReadinessProbe(provider: MetadataInferenceProvider, model: string): PreflightProbe {
  return async (signal: AbortSignal): Promise<PreflightProbeResult> => {
    try {
      const content = await provider.complete(
        { model, messages: [{ role: "user", content: `Respond with only the single word "ready". Prompt: ${PROBE_TEXT}` }], maxTokens: 16 },
        { signal },
      );
      if (typeof content !== "string" || content.trim().length === 0) {
        return result("unavailable", "LOCAL_METADATA_UNREACHABLE");
      }
      return result("ok", "LOCAL_METADATA_READY");
    } catch {
      return result("unavailable", "LOCAL_METADATA_UNREACHABLE");
    }
  };
}

export interface ReadOnlyAppleBooksAccessReader {
  checkAccess(signal?: AbortSignal): Promise<Omit<AppleBooksReadResult, "annotations"> & { annotations?: never }>;
}

const APPLE_BOOKS_DEGRADED_STATUSES: ReadonlySet<AppleBooksReadStatus> = new Set(["empty", "partial", "source_changing"]);

/**
 * Wraps `AppleBooksSqliteReader.checkAccess` -- a read-only status probe by
 * the reader's own contract (never imports, opens for write, or copies the
 * source database). Only the closed `status` enum value is ever read into
 * the report; `diagnostics`/`sources`/any raw database path never is.
 */
export function createAppleBooksReadinessProbe(reader: ReadOnlyAppleBooksAccessReader): PreflightProbe {
  return async (signal: AbortSignal): Promise<PreflightProbeResult> => {
    try {
      const outcome = await reader.checkAccess(signal);
      if (outcome.status === "success") {
        return result("ok", "APPLE_BOOKS_READY", { readStatus: outcome.status });
      }
      if (APPLE_BOOKS_DEGRADED_STATUSES.has(outcome.status)) {
        return result("degraded", "APPLE_BOOKS_DEGRADED", { readStatus: outcome.status });
      }
      return result("unavailable", "APPLE_BOOKS_UNAVAILABLE", { readStatus: outcome.status });
    } catch {
      return result("unavailable", "APPLE_BOOKS_UNAVAILABLE");
    }
  };
}

/**
 * Wraps an injected, ALREADY-boolean credential-readiness check -- never
 * the credential value itself, never a call to Exa or any other research
 * provider. `hasCredential` is expected to be something like "does
 * Keychain have an entry for this service/account", not "is this key
 * valid" (validating the key's value would require a live outbound call,
 * which this checkpoint's preflight never makes).
 */
export function createResearchCredentialReadinessProbe(hasCredential: (signal?: AbortSignal) => Promise<boolean>): PreflightProbe {
  return async (signal: AbortSignal): Promise<PreflightProbeResult> => {
    try {
      const present = await hasCredential(signal);
      return present ? result("ok", "RESEARCH_CREDENTIAL_READY") : result("degraded", "RESEARCH_CREDENTIAL_MISSING");
    } catch {
      return result("degraded", "RESEARCH_CREDENTIAL_CHECK_FAILED");
    }
  };
}

export interface ReadOnlyBackgroundSchedulerStatus {
  /** Status-only: never `reconcile()`/`remove()` -- see `BackgroundScheduler.status()`'s own doc comment ("stays read-only"). */
  status(): Promise<BackgroundReconcileStatus>;
}

const OK_SCHEDULER_STATUSES: ReadonlySet<BackgroundReconcileStatus> = new Set(["installed", "unsupported-platform", "disabled"]);
const DEGRADED_SCHEDULER_STATUSES: ReadonlySet<BackgroundReconcileStatus> = new Set(["removed", "not-loaded"]);

/** Wraps `BackgroundScheduler.status()` only -- never `reconcile()`/`remove()` (Checkpoint 9 requirement 6: "status-only probe, no reconcile/install/remove"). */
export function createBackgroundSchedulerReadinessProbe(scheduler: ReadOnlyBackgroundSchedulerStatus): PreflightProbe {
  return async (): Promise<PreflightProbeResult> => {
    try {
      const status = await scheduler.status();
      if (OK_SCHEDULER_STATUSES.has(status)) {
        return result("ok", status === "unsupported-platform" ? "BACKGROUND_SCHEDULER_UNSUPPORTED" : "BACKGROUND_SCHEDULER_INSTALLED", { schedulerStatus: status });
      }
      if (DEGRADED_SCHEDULER_STATUSES.has(status)) {
        return result("degraded", "BACKGROUND_SCHEDULER_NOT_CONFIGURED", { schedulerStatus: status });
      }
      return result("unavailable", "BACKGROUND_SCHEDULER_CONFLICT", { schedulerStatus: status });
    } catch {
      return result("unavailable", "BACKGROUND_SCHEDULER_CHECK_FAILED");
    }
  };
}
