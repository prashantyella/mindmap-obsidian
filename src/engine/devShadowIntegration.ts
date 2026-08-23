import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { EXA_KEYCHAIN_ACCOUNT, EXA_KEYCHAIN_SERVICE } from "../keychainCredential";
import { createOllamaMetadataProvider } from "./localMetadataProvider";
import { createAppleBooksReadinessProbe, createLocalMetadataReadinessProbe, createOllamaEmbeddingReadinessProbe, createResearchCredentialReadinessProbe } from "./preflightProbes";
import { createWindowSleep, OllamaEmbeddingProvider } from "./ollamaEmbeddingProvider";
import { getScopeSetupStatus as resolveScopeSetupStatus } from "../pluginConfig";
import { AppleBooksSqliteReader, createNodeAppleBooksFsAdapter } from "../reading/appleBooksSqlite";
import { createNodeSqliteProcess } from "../reading/sqliteProcess";
import type { DevShadowIntegration, DevShadowIntegrationHost } from "virtual:mindmap-dev-shadow";
import { MindmapEngine, type MindmapEngineProbes } from "./mindmapEngine";
import { NodeOwnedFs } from "./nodeFs";
import { projectSource } from "./sourceProjection";
import type { NoteIdentityV1 } from "./contracts";
import { parseShadowBaselineV1, runShadowComparison, type ShadowBaselineV1, type ShadowComparisonV1, type ShadowNoteSource } from "./shadowEngine";
import { createVaultCatalogShadowSource } from "./vaultCatalogReader";

const DEFAULT_MINIMUM_WORDS = 30;
const MAX_BASELINE_FILE_BYTES = 4 * 1024 * 1024;
/** Small fixed limit for `config.json` -- stated before allocating for the read, never after (Checkpoint 9 closure review item 3). Well above any real config file's size (a few KB) but far below anything that would make an unbounded read a concern. */
const MAX_CONFIG_FILE_BYTES = 1 * 1024 * 1024;
const BASELINE_FILE_NAME = "shadow-baseline.json";
/** Per-note bound on the PROJECTED text handed to the embedding provider for related-parity -- mirrors the same normalized/projected input the index itself was built from (closure review item 7), never raw unprocessed note content. */
const MAX_EMBED_INPUT_CHARS_PER_NOTE = 8000;

interface DevRuntimeConfig {
  minimumWords: number;
  embedProvider?: string;
  embedBaseUrl?: string;
  embedModel?: string;
  /** Ollama-only contract (Checkpoint 9 closure review item 3): the local-metadata provider this integration ever wires is `ollama`, never `openai_compatible` -- no API key is ever read or stored by this module. */
  llmProvider?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  /** Same `chunk_target_tokens`/`chunk_overlap_tokens` config keys the Python oracle (and its baseline generator) read -- threaded into `runShadowComparison` so both sides chunk under the SAME options rather than TS silently using its own hardcoded default (closure review item 1: "the exact same deterministic catalog/sample ordering and options as TS"). */
  chunkTargetTokens?: number;
  chunkOverlapTokens?: number;
}

/** Stats `configPath` BEFORE reading it, rejecting an oversized file without allocating for its contents -- refreshed on every call (never cached), so this always reflects the CURRENT on-disk config, not a stale snapshot captured once at integration construction (closure review item 3). Returns `null` on any failure (missing, oversized, unreadable, malformed JSON), never throws. */
function readBoundedJsonConfig(configPath: string): Record<string, unknown> | null {
  try {
    const stat = fs.statSync(configPath);
    if (stat.size > MAX_CONFIG_FILE_BYTES) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Derives the narrow `DevRuntimeConfig` shape this module needs from a freshly-read raw config object. */
function toDevRuntimeConfig(raw: Record<string, unknown> | null): DevRuntimeConfig {
  if (!raw) return { minimumWords: DEFAULT_MINIMUM_WORDS };
  const minimumWordsCandidate = Number(raw.min_note_words ?? DEFAULT_MINIMUM_WORDS);
  return {
    minimumWords: Number.isFinite(minimumWordsCandidate) && minimumWordsCandidate >= 0 ? minimumWordsCandidate : DEFAULT_MINIMUM_WORDS,
    embedProvider: typeof raw.embed_provider === "string" ? raw.embed_provider : undefined,
    embedBaseUrl: typeof raw.embed_base_url === "string" ? raw.embed_base_url : undefined,
    embedModel: typeof raw.embed_model === "string" ? raw.embed_model : undefined,
    llmProvider: typeof raw.llm_provider === "string" ? raw.llm_provider : undefined,
    llmBaseUrl: typeof raw.llm_base_url === "string" ? raw.llm_base_url : undefined,
    llmModel: typeof raw.llm_model === "string" ? raw.llm_model : undefined,
    chunkTargetTokens: Number.isInteger(raw.chunk_target_tokens) ? (raw.chunk_target_tokens as number) : undefined,
    chunkOverlapTokens: Number.isInteger(raw.chunk_overlap_tokens) ? (raw.chunk_overlap_tokens as number) : undefined,
  };
}

/** Reads the SAME Python `config.json` production reads, bounded and fresh -- see `readBoundedJsonConfig`. */
function readDevRuntimeConfig(configPath: string): DevRuntimeConfig {
  return toDevRuntimeConfig(readBoundedJsonConfig(configPath));
}

function createOllamaEmbeddingProviderFromConfig(cfg: DevRuntimeConfig, fetchImpl: typeof fetch): OllamaEmbeddingProvider | null {
  if (!(cfg.embedProvider === "ollama" && cfg.embedBaseUrl && cfg.embedModel)) return null;
  return new OllamaEmbeddingProvider({ baseUrl: cfg.embedBaseUrl, model: cfg.embedModel }, { fetchImpl, sleep: createWindowSleep() });
}

function createAppleBooksReaderFromConfig(rawConfig: Record<string, unknown>): AppleBooksSqliteReader {
  return new AppleBooksSqliteReader({
    sqliteProcess: createNodeSqliteProcess(),
    fs: createNodeAppleBooksFsAdapter(),
    config: rawConfig,
    homeDirectory: os.homedir(),
  });
}

/**
 * Boolean-ONLY macOS Keychain existence check for the Exa web-research
 * credential -- deliberately does NOT use `-w` (the flag that would print
 * the credential's value), so the credential's value is never read into
 * this process at all, let alone returned or logged. Never calls Exa
 * itself. Resolves `false` (never throws) on any spawn/exit failure,
 * including on a non-macOS platform where `/usr/bin/security` does not
 * exist.
 *
 * Accepts `signal` (Checkpoint 9 closure review item 3): on abort, the
 * spawned child is killed, listeners are removed, and the promise settles
 * immediately with `false` -- `preflight.ts`'s own bounded-timeout race
 * aborts this same signal when a check's timeout elapses, so a child
 * process here is never left running past that timeout.
 */
function hasResearchCredential(signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => {
      child?.kill();
      settle(false);
    };
    try {
      child = spawn("/usr/bin/security", ["find-generic-password", "-s", EXA_KEYCHAIN_SERVICE, "-a", EXA_KEYCHAIN_ACCOUNT], { stdio: "ignore" });
    } catch {
      settle(false);
      return;
    }
    if (signal?.aborted) {
      child.kill();
      settle(false);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => settle(false));
    child.on("close", (code) => settle(code === 0));
  });
}

function hashIdentityKey(identity: NoteIdentityV1): string {
  const key = identity.kind === "apple-annotation" ? `apple-annotation:${identity.appleAnnotationId}` : `path:${identity.canonicalPath}`;
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Bounded, fail-soft plugin-owned baseline loader: stats the file BEFORE
 * reading it (rejecting an oversized one without allocating), parses it
 * strictly via `parseShadowBaselineV1`, and collapses EVERY failure mode
 * (missing file, oversized file, malformed JSON, a baseline that fails
 * strict validation) to `null` plus one static, redacted log line -- never
 * a raw parse error or file-read error surfacing to the caller. A missing
 * file (the common case: no baseline has been generated yet) is silent,
 * not logged as a failure.
 *
 * Generated by `tools/parity/generate_shadow_baseline.py` (dev-only,
 * never shipped/imported from `src` or production dist -- see that
 * script's own doc comment).
 */
/**
 * Checkpoint 9 parity-signal correction item 5 ("report honesty"): explicitly names which
 * comparison domains (`comparison.availability`) were actually evaluated this run and which
 * stayed unavailable, instead of a two-counter summary that could be misread as full parity. A
 * baseline that only carries eligibility/projection/chunk fields (no related/apple sections) must
 * never imply related/apple parity was checked -- those stay explicitly "unavailable" here, and no
 * agreement/disagreement count for an unavailable domain is ever shown as if it meant something.
 */
function formatComparisonDomainSummary(comparison: ShadowComparisonV1): string {
  const availability = comparison.availability;
  const domains = [
    availability.eligibility ? `eligibility(disagree ${comparison.eligibilityDisagreementCount})` : "eligibility(unavailable)",
    availability.projection ? `projection(agree ${comparison.projectionDigestAgreementCount}/disagree ${comparison.projectionDigestDisagreementCount})` : "projection(unavailable)",
    availability.chunks
      ? `chunks(digestAgree ${comparison.chunkDigestAgreementCount}/disagree ${comparison.chunkDigestDisagreementCount}, countAgree ${comparison.chunkCountAgreementCount}/disagree ${comparison.chunkCountDisagreementCount})`
      : "chunks(unavailable)",
    availability.related ? `related(disagree ${comparison.emptyNonEmptyDisagreementCount})` : "related(unavailable)",
    availability.apple
      ? `apple(statusMatches ${String(comparison.appleStatusMatches)}, countDelta ${String(comparison.appleCountDelta)}, idDigestMatches ${String(comparison.appleAnnotationIdDigestMatches)})`
      : "apple(unavailable)",
    availability.index ? `index(countDelta ${String(comparison.indexCountDelta)})` : "index(unavailable)",
  ];
  return comparison.comparisonUnavailable ? `comparison unavailable (no comparable domain evaluated) [${domains.join(", ")}]` : domains.join(", ");
}

function loadShadowBaseline(dataRoot: string, appendLog: (message: string) => void): ShadowBaselineV1 | null {
  const baselinePath = path.join(dataRoot, BASELINE_FILE_NAME);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(baselinePath);
  } catch {
    return null; // no baseline generated yet -- not a failure, nothing to log
  }
  if (stat.size > MAX_BASELINE_FILE_BYTES) {
    appendLog(`[shadow] baseline load skipped: file exceeds the bounded size (${stat.size} > ${MAX_BASELINE_FILE_BYTES} bytes).`);
    return null;
  }
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    return parseShadowBaselineV1(raw);
  } catch {
    appendLog("[shadow] baseline load skipped: file is missing, unreadable, or failed strict validation.");
    return null;
  }
}

/**
 * Real dev-only implementation behind `virtual:mindmap-dev-shadow`
 * (Checkpoint 9 requirement 4) -- this is the ONLY module that composes a
 * real `MindmapEngine` for the development shadow command, and it owns and
 * disposes that engine itself (requirement 5: "Dev integration owns/
 * disposes its engine; main has no production mindmapEngine property").
 *
 * `run()` uses ONLY `MindmapEngine.inspectReadOnly()` -- never `start()`.
 * A baseline is loaded fresh on every `run()` (never at construction), and
 * every optional live probe/embedding/Apple-reader call below only ever
 * happens INSIDE this explicit `run()` -- never automatically at load or
 * engine construction. Every optional preflight probe re-reads
 * `config.json` fresh at the moment it is INVOKED (which only happens
 * while `engine.inspectReadOnly()` runs, i.e. only inside an explicit
 * `run()`) rather than closing over a config snapshot captured once at
 * construction time (closure review item 3).
 */

const STATIC_FAILURE_MESSAGE = "Mindmap dev shadow diagnostics failed to complete. See the plugin log for details.";
const STATIC_BUSY_MESSAGE = "Mindmap dev shadow diagnostics are already running.";

export function createDevShadowIntegration(host: DevShadowIntegrationHost): DevShadowIntegration {
  const dataRoot = path.join(host.pluginDir, "data", "mindmap-engine");

  function currentConfigPath(): string {
    try {
      return host.getResolvedRuntime().configPath;
    } catch {
      return "";
    }
  }

  // Concrete Milestone-A preflight probe factories. Each one is a THIN closure that re-reads
  // config.json and (re)composes its underlying provider/reader FRESH every time `runPreflight`
  // actually invokes it -- never a fixed snapshot captured once here at construction (closure
  // review item 3). An unconfigured capability reports degraded/"not configured", never a
  // fabricated "ok". None of these fire except while `engine.inspectReadOnly()` runs inside an
  // explicit `run()`.
  const probes: MindmapEngineProbes = {
    ollama: async (signal) => {
      const cfg = readDevRuntimeConfig(currentConfigPath());
      const provider = createOllamaEmbeddingProviderFromConfig(cfg, host.fetchImpl);
      if (!provider || !cfg.embedModel) return { status: "degraded", message: "Ollama embeddings are not configured." };
      return createOllamaEmbeddingReadinessProbe(provider, { model: cfg.embedModel })(signal);
    },
    localMetadataProvider: async (signal) => {
      const cfg = readDevRuntimeConfig(currentConfigPath());
      if (!(cfg.llmProvider === "ollama" && cfg.llmBaseUrl && cfg.llmModel)) {
        return { status: "degraded", message: "Local metadata inference is not configured." };
      }
      const provider = createOllamaMetadataProvider({ baseUrl: cfg.llmBaseUrl }, { fetchImpl: host.fetchImpl });
      return createLocalMetadataReadinessProbe(provider, cfg.llmModel)(signal);
    },
    // Boolean-only, never calls Exa, never exposes the credential value -- see hasResearchCredential.
    researchProvider: createResearchCredentialReadinessProbe(hasResearchCredential),
    // Composed fresh per invocation over the existing read-only AppleBooksSqliteReader --
    // checkAccess() only, cancellable, no import/write, no raw DB path ever leaving this probe
    // (Checkpoint 9 closure review item 2).
    appleBooksReading: async (signal) => {
      const raw = readBoundedJsonConfig(currentConfigPath());
      const reader = createAppleBooksReaderFromConfig(raw ?? {});
      return createAppleBooksReadinessProbe(reader)(signal);
    },
    // BACKGROUND_SCHEDULER stays deliberately unconfigured this pass: no part of this codebase
    // composes a real BackgroundScheduler outside production's own separate LaunchAgent path (no
    // already-constructed instance exists to reuse), and building a brand-new one solely for this
    // dev-only probe was judged out of scope. Reports "not configured"/degraded, never "ok".
  };

  const engine = new MindmapEngine({
    dataRoot,
    fs: new NodeOwnedFs(dataRoot),
    registrar: {
      registerInterval: (callback, intervalMs) => host.registerInterval(callback, intervalMs),
      cancelInterval: (handle) => window.clearInterval(handle as number),
    },
    probes,
  });

  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let runAbort: AbortController | null = null;

  /**
   * Embeds the SAME projected/normalized text indexing itself would use
   * (via `projectSource`, never raw `rawContent`) for related-parity, over
   * the exact `sample` already fetched by the ONE catalog pass `runOnce`
   * performs -- never a second vault enumeration (closure review item 7).
   */
  async function embedProjectedSample(
    sample: readonly { identity: NoteIdentityV1; rawContent: string }[],
    cfg: DevRuntimeConfig,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, Float32Array> | undefined> {
    const provider = createOllamaEmbeddingProviderFromConfig(cfg, host.fetchImpl);
    if (!provider || !cfg.embedModel || sample.length === 0) return undefined;
    const projected = sample.map((note) => {
      try {
        // `note.identity` is already a validated NoteIdentityV1-shaped value from the catalog plan.
        return projectSource(note.identity, note.rawContent).projectedBody.slice(0, MAX_EMBED_INPUT_CHARS_PER_NOTE);
      } catch {
        return null;
      }
    });
    try {
      const batch = await provider.embedBatch(
        {
          model: cfg.embedModel,
          items: sample.map((_note, index) => ({ id: String(index), text: projected[index] ?? "" })).filter((item) => item.text.length > 0),
        },
        { signal },
      );
      const map = new Map<string, Float32Array>();
      const includedIndexes = sample.map((_note, index) => index).filter((index) => (projected[index]?.length ?? 0) > 0);
      batch.items.forEach((item, batchIndex) => {
        const sampleIndex = includedIndexes[batchIndex];
        if (sampleIndex === undefined) return;
        map.set(hashIdentityKey(sample[sampleIndex].identity), Float32Array.from(item.values));
      });
      return map;
    } catch {
      // A failed/cancelled embedding pass leaves related-parity unavailable (no query vectors),
      // never fabricates zero/agreement -- see shadowEngine.ts's RELATED_PREVIEW_SKIPPED_NO_VECTOR.
      return undefined;
    }
  }

  async function runOnce(signal: AbortSignal): Promise<void> {
    const preflight = await engine.inspectReadOnly();
    if (disposed || signal.aborted) return;

    const runtime = host.getResolvedRuntime();
    const scopeStatus = resolveScopeSetupStatus(runtime, host.canManageConfig(runtime));
    const rawConfig = readBoundedJsonConfig(runtime.configPath);
    const cfg = toDevRuntimeConfig(rawConfig);
    // The Reading root is always included explicitly (Checkpoint 9 requirement 12: "Add
    // Reading root explicitly"), independent of whatever ordinary scope folders are configured --
    // shadow comparison needs to see Apple Books annotation notes even when the user's "all
    // scope" selection does not happen to cover `Books/Apple Books`.
    const noteSource = createVaultCatalogShadowSource({
      vault: host.vault,
      scopeFolders: scopeStatus.currentPaths,
      includeReadingAnnotations: true,
      minimumWords: cfg.minimumWords,
      configDir: host.vault.configDir,
    });

    const baseline = loadShadowBaseline(dataRoot, (message) => host.appendLog(message));

    // Exactly ONE catalog pass: the vault is enumerated/read here, once, via the real
    // `noteSource`; every downstream consumer (the embedding pass and `runShadowComparison`
    // itself) reuses this SAME fetched sample through a static wrapper below -- never a second
    // enumeration (closure review item 7).
    let sample: readonly { identity: NoteIdentityV1; rawContent: string }[] = [];
    let sourceEnumerationAborted = false;
    try {
      sample = await noteSource.listEligibleSample(50, signal);
    } catch {
      // A throwing source is treated as an empty sample below -- runShadowComparison's own
      // static-wrapper source never throws, so this is the one place that failure is absorbed.
    }
    if (signal.aborted) sourceEnumerationAborted = true;
    const catalogSkipReasonCounts = noteSource.getSkipReasonCounts();
    const cachedSource: ShadowNoteSource = {
      listEligibleSample: async () => sample,
      // Forwarded so `runShadowComparison` itself surfaces these into `ShadowReportV1.sourceSkipReasonCounts` (closure review item 8) -- the cached wrapper otherwise has no skip reasons of its own.
      getSkipReasonCounts: () => catalogSkipReasonCounts,
    };

    if (disposed) return;

    // TS index count/query are only ever wired through the read-only IndexStore facade, and ONLY
    // when the current generation is FULLY verified (checksums, shapes, shard declarations, and a
    // live sample query all pass) -- `verifyCurrentGenerationFully()` returns `null` for a
    // fresh/empty index OR when verification itself fails for any reason, in which case
    // `indexQuery`/`tsIndexNoteCount` both stay absent (never queried against a merely
    // manifest-present, unverified generation -- closure review item 6).
    const verifiedGeneration = signal.aborted ? null : await engine.indexStore.verifyCurrentGenerationFully();
    if (disposed || signal.aborted) return;

    const queryVectorsByHashedId = verifiedGeneration ? await embedProjectedSample(sample, cfg, signal) : undefined;
    if (disposed || signal.aborted) return;

    // Apple parity is wired ONLY when the loaded baseline actually requests Apple data -- a
    // missing baseline.appleReader means zero sqlite calls from this comparison path (closure
    // review item 2). Composed fresh, never automatically at construction/load.
    const appleReader = baseline?.appleReader && !signal.aborted
      ? { read: (readSignal?: AbortSignal) => createAppleBooksReaderFromConfig(rawConfig ?? {}).readAnnotations(readSignal) }
      : undefined;

    const shadowReport = await runShadowComparison(
      { noteSource: cachedSource, indexQuery: verifiedGeneration ? engine.indexStore : undefined, queryVectorsByHashedId, appleReader },
      {
        signal,
        baseline: baseline ?? undefined,
        tsIndexNoteCount: verifiedGeneration ? verifiedGeneration.noteCount : undefined,
        chunkTargetTokens: cfg.chunkTargetTokens,
        chunkOverlapTokens: cfg.chunkOverlapTokens,
      },
    );
    if (disposed) return;

    const comparisonSummary = formatComparisonDomainSummary(shadowReport.comparison);
    const abortedNote = shadowReport.aborted || sourceEnumerationAborted ? " (cancelled before completion)" : "";
    const summary = `Mindmap dev shadow: runtime ${preflight.summary.overallStatus}, sampled ${shadowReport.metrics.sampleSize} notes, ${shadowReport.metrics.projectedCount} projected, ${shadowReport.metrics.chunkCountTotal} chunks, ${comparisonSummary}${abortedNote}.`;
    host.notice(summary, 12000);
    host.appendLog(`[shadow] ${summary}`);
    host.appendLog(`[shadow] reasonCodeCounts=${JSON.stringify(shadowReport.reasonCodeCounts)}`);
    host.appendLog(`[shadow] catalogSkipReasonCounts=${JSON.stringify(catalogSkipReasonCounts)}`);
  }

  return {
    async run(): Promise<void> {
      if (disposed) return;
      if (inFlight) {
        host.notice(STATIC_BUSY_MESSAGE, 6000);
        return;
      }
      const controller = new AbortController();
      runAbort = controller;
      // Deliberately caught HERE, at the one call site, rather than letting a raw error/message
      // propagate to a caller-owned catch: the static failure text below is the only text a
      // thrown probe/read error can ever surface through this integration (requirement 5: "catches
      // to one static Notice/log code, never raw error.message").
      const attempt = runOnce(controller.signal).catch(() => {
        if (!disposed) host.notice(STATIC_FAILURE_MESSAGE, 12000);
      });
      inFlight = attempt;
      try {
        await attempt;
      } finally {
        if (inFlight === attempt) inFlight = null;
        if (runAbort === controller) runAbort = null;
      }
    },
    dispose(): void {
      disposed = true;
      runAbort?.abort();
      void engine.dispose();
    },
  };
}
