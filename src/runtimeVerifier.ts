import { parsePreflightOutput } from "./diagnostics";
import type { ProcessInvoker } from "./runtimeDiscovery";

/**
 * python/mindmap.py's run_preflight() always emits exactly one check from
 * each of these four groups (interpreter, ruamel.yaml, chromadb, config
 * parse), in that order, before any provider/model/scope check. Every other
 * code (CONFIG_FIELDS_MISSING, LLM_*, OLLAMA_*, APPLE_BOOKS_*, provider
 * timeouts, ...) describes provider/model/scope readiness, which must never
 * gate or downgrade an otherwise installable runtime and must never trigger
 * a reinstall.
 */
interface RuntimeCheckGroup {
  /** Every code this group could report, ok or not. */
  codes: readonly string[];
  /** The one code within `codes` that means this group passed. */
  okCode: string;
}

const RUNTIME_CHECK_GROUPS: readonly RuntimeCheckGroup[] = [
  { codes: ["PYTHON_RUNTIME_OK"], okCode: "PYTHON_RUNTIME_OK" },
  { codes: ["DEPENDENCY_RUAMEL_OK", "DEPENDENCY_RUAMEL_MISSING"], okCode: "DEPENDENCY_RUAMEL_OK" },
  { codes: ["DEPENDENCY_CHROMADB_OK", "DEPENDENCY_CHROMADB_MISSING"], okCode: "DEPENDENCY_CHROMADB_OK" },
  { codes: ["CONFIG_MISSING", "CONFIG_INVALID", "CONFIG_EMPTY", "CONFIG_OK"], okCode: "CONFIG_OK" },
];

export interface RuntimePreflightCheck {
  code: string;
  status: "ok" | "error" | "skipped";
}

/**
 * True only when every one of the four runtime-check groups above reports
 * exactly one occurrence of exactly one of its codes, that code is the
 * group's designated success code, and its status is "ok". This is fail
 * closed on every other shape a checks array could take:
 *
 * - A group missing entirely (e.g. a truncated preflight run that stopped
 *   after the interpreter check) is not ready — a complete-set requirement,
 *   not "every check that happens to be present is ok".
 * - A group reporting its failure code is not ready, even if a spoofed
 *   "ok" status is attached to that failure code: only the designated
 *   success code counts, regardless of status text.
 * - A group reporting more than one of its codes — the same code repeated,
 *   or two conflicting codes from the same group both present (e.g. both
 *   DEPENDENCY_RUAMEL_OK and DEPENDENCY_RUAMEL_MISSING in one payload) — is
 *   rejected outright rather than picking whichever code happens to look
 *   best; a well-formed preflight run never produces that shape.
 */
export function evaluateRuntimePreflight(checks: RuntimePreflightCheck[]): boolean {
  const codeCounts = new Map<string, number>();
  for (const check of checks) {
    codeCounts.set(check.code, (codeCounts.get(check.code) ?? 0) + 1);
  }

  return RUNTIME_CHECK_GROUPS.every((group) => {
    const presentCodes = group.codes.filter((code) => codeCounts.has(code));
    if (presentCodes.length !== 1) return false;

    const [onlyCode] = presentCodes;
    if ((codeCounts.get(onlyCode) ?? 0) !== 1) return false;
    if (onlyCode !== group.okCode) return false;

    const check = checks.find((candidate) => candidate.code === onlyCode);
    return check?.status === "ok";
  });
}

export interface RuntimePreflightVerifierOptions {
  scriptPath: string;
  configPath: string;
  invoke: ProcessInvoker;
}

/**
 * Builds a `PreflightVerifier` (see runtimeDiscovery.ts) that runs the
 * bundled Mindmap script's isolated `--runtime-preflight` mode under the
 * candidate interpreter and judges readiness using only the runtime-specific
 * checks above. `--runtime-preflight` (python/mindmap.py's
 * `run_runtime_preflight`) executes ONLY the interpreter/ruamel.yaml/
 * chromadb/config-parse checks — it never runs Apple Books discovery,
 * provider/model HTTP, oMLX, a Chroma client, or a vault scan, so a
 * dependency-ready or freshly-installed interpreter can never be
 * downgraded or blocked by unrelated provider/network state hanging until
 * `invoke`'s own timeout. Never throws: any spawn/parse failure is treated
 * as not ready.
 */
export function buildRuntimePreflightVerifier(options: RuntimePreflightVerifierOptions): (interpreterPath: string) => Promise<boolean> {
  return async (interpreterPath: string): Promise<boolean> => {
    try {
      const invocation = await options.invoke(interpreterPath, [options.scriptPath, "--config", options.configPath, "--runtime-preflight"]);
      if (invocation.error) return false;
      const result = parsePreflightOutput(invocation.stdout, invocation.stderr, invocation.exitCode ?? 1);
      return evaluateRuntimePreflight(result.checks);
    } catch {
      return false;
    }
  };
}
