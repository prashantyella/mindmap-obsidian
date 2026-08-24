import { execFile } from "node:child_process";

/**
 * The only subprocess seam Reading-mode SQLite access goes through.
 * `createNodeSqliteProcess()` is the sole real implementation and always
 * invokes exactly `/usr/bin/sqlite3` -- never a shell, never a
 * user-configurable binary path, never `node:sqlite`/a native addon/WASM.
 * Tests substitute a fake implementing this same interface.
 */
export interface SqliteRunOptions {
  /** SQL/dot-command script fed to sqlite3 over stdin -- never interpolated into argv. */
  script: string;
  /** CLI flags placed before the database path. Must be an exact subset of `ALLOWED_EXTRA_ARGS` -- fixed, never derived from user/source content, and never `-cmd`/`-init`/an extension-loading flag. */
  extraArgs: readonly string[];
  /** The database file to open. A single, distinct argv element -- never concatenated with `extraArgs` or `script`. Must be an absolute, control-character-free path. */
  dbPath: string;
  /** Hard upper bound is `MAX_SQLITE_TIMEOUT_MS` (60s); the adapter rejects anything larger before spawning. */
  timeoutMs: number;
  /** Bounds both stdout and stderr independently (Node's `maxBuffer`). Hard upper bound is `MAX_OUTPUT_BYTES_CEILING`; exceeding either kills the process and rejects. */
  maxOutputBytes: number;
  /** Caller-driven cancellation, independent of the timeout. */
  signal?: AbortSignal;
}

export interface SqliteRunResult {
  stdout: string;
  stderr: string;
}

export type SqliteProcessErrorKind =
  | "binary-missing"
  | "timeout"
  | "cancelled"
  | "output-too-large"
  | "spawn-failed"
  | "exited-with-error";

/**
 * The only shape `SqliteProcess.run()` ever rejects with (Error-only
 * rejection). `kind` is a small closed classification a caller can safely
 * branch on; the human-readable `message` is always one of a small fixed
 * set of static strings -- it never embeds raw stderr, stdout, or argv
 * content, so a caller can put it directly into a user-facing diagnostic
 * without redacting anything.
 */
export class SqliteProcessError extends Error {
  readonly kind: SqliteProcessErrorKind;
  /** The underlying Node/child_process error, kept only for internal diagnostics -- never surfaced in a user-facing diagnostic message. */
  readonly cause?: unknown;

  constructor(kind: SqliteProcessErrorKind, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SqliteProcessError";
    this.kind = kind;
    this.cause = options?.cause;
  }
}

export interface SqliteProcess {
  run(options: SqliteRunOptions): Promise<SqliteRunResult>;
}

export const SQLITE_BINARY_PATH = "/usr/bin/sqlite3";
export const MAX_SQLITE_TIMEOUT_MS = 60_000;
/** Hard ceiling on `maxOutputBytes` regardless of what a caller requests -- 64MB is far beyond any plausible Apple Books annotation/library export. */
export const MAX_OUTPUT_BYTES_CEILING = 64 * 1024 * 1024;
/**
 * The exact, closed set of CLI flags this reader is ever allowed to pass.
 * Deliberately excludes `-cmd`/`-init` (arbitrary pre-execution SQL/dot-command
 * injection points) and any extension-loading flag -- this reader only ever
 * needs read-only, non-interactive, unlabeled-column output.
 */
export const ALLOWED_EXTRA_ARGS: ReadonlySet<string> = new Set(["-readonly", "-batch", "-list"]);

/**
 * The exact, minimal environment every real invocation runs with --
 * `PATH`/`LC_ALL` only. Deliberately never `{ ...process.env }` or any
 * spread of the parent environment: that would forward whatever API keys,
 * provider tokens, `PIP_*`/`NPM_*` credentials, etc. happen to be set in
 * Obsidian's own process environment to a subprocess that has no reason to
 * ever see them.
 */
export const SQLITE_PROCESS_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
});

// eslint-disable-next-line no-control-regex -- intentionally rejects control/NUL bytes in a filesystem path
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;

function validateRunOptions(options: SqliteRunOptions): void {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_SQLITE_TIMEOUT_MS) {
    throw new SqliteProcessError("spawn-failed", `timeoutMs must be a positive integer no greater than ${MAX_SQLITE_TIMEOUT_MS}.`);
  }
  if (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0 || options.maxOutputBytes > MAX_OUTPUT_BYTES_CEILING) {
    throw new SqliteProcessError("spawn-failed", `maxOutputBytes must be a positive integer no greater than ${MAX_OUTPUT_BYTES_CEILING}.`);
  }
  if (options.dbPath.trim() === "" || !options.dbPath.startsWith("/") || CONTROL_CHAR_PATTERN.test(options.dbPath)) {
    throw new SqliteProcessError("spawn-failed", "dbPath must be a non-empty, absolute, control-character-free path.");
  }
  for (const arg of options.extraArgs) {
    if (!ALLOWED_EXTRA_ARGS.has(arg)) {
      throw new SqliteProcessError("spawn-failed", "extraArgs contained a flag outside the fixed allowlist.");
    }
  }
}

interface NodeExecFileError extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

function classifyExecFileError(error: NodeExecFileError, timedOut: boolean, cancelled: boolean): SqliteProcessError {
  if (cancelled) {
    return new SqliteProcessError("cancelled", "The sqlite3 query was cancelled.", { cause: error });
  }
  if (timedOut) {
    return new SqliteProcessError("timeout", "The sqlite3 query did not complete within the allotted time.", { cause: error });
  }
  if (error.code === "ENOENT") {
    return new SqliteProcessError("binary-missing", "The /usr/bin/sqlite3 executable was not found.", { cause: error });
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new SqliteProcessError("output-too-large", "sqlite3 produced more output than the bounded limit allows.", { cause: error });
  }
  if (error.killed || error.signal) {
    return new SqliteProcessError("spawn-failed", "The sqlite3 process was terminated unexpectedly.", { cause: error });
  }
  return new SqliteProcessError("exited-with-error", "sqlite3 exited with an error.", { cause: error });
}

/**
 * Combines up to two `AbortSignal`s into one without `AbortSignal.any`
 * (added in a newer runtime baseline than this plugin's minimum supported
 * Electron/Node floor guarantees). Listeners are removed via the returned
 * `cleanup()` regardless of which signal (if either) actually fired, so a
 * completed run never leaks a listener onto a long-lived caller-supplied
 * signal.
 */
function combineAbortSignals(primary: AbortSignal, secondary?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  if (!secondary) {
    return { signal: primary, cleanup: () => {} };
  }
  const combined = new AbortController();
  const onPrimaryAbort = () => combined.abort();
  const onSecondaryAbort = () => combined.abort();
  if (primary.aborted || secondary.aborted) {
    combined.abort();
  } else {
    primary.addEventListener("abort", onPrimaryAbort, { once: true });
    secondary.addEventListener("abort", onSecondaryAbort, { once: true });
  }
  return {
    signal: combined.signal,
    cleanup: () => {
      primary.removeEventListener("abort", onPrimaryAbort);
      secondary.removeEventListener("abort", onSecondaryAbort);
    },
  };
}

/**
 * The sole real `SqliteProcess`: fixed, allowlisted argv (`extraArgs` then
 * `dbPath`, always separate array elements -- never string-concatenated or
 * shell-interpolated), `shell: false`, the minimal allowlisted environment,
 * a bounded independent stdout/stderr buffer, and an explicit timeout
 * capped at `MAX_SQLITE_TIMEOUT_MS`. Cancellation via `signal` is layered
 * on top of (and distinguished from) the timeout using two independent
 * `AbortController`s combined by `combineAbortSignals` (not
 * `AbortSignal.any`), so a caller can tell "this was cancelled" apart from
 * "this timed out" even though both kill the same child process.
 */
export function createNodeSqliteProcess(): SqliteProcess {
  return {
    async run(options: SqliteRunOptions): Promise<SqliteRunResult> {
      validateRunOptions(options);
      if (options.signal?.aborted) {
        throw new SqliteProcessError("cancelled", "The sqlite3 query was cancelled.");
      }

      const timeoutController = new AbortController();
      const timeoutHandle = window.setTimeout(() => timeoutController.abort(), options.timeoutMs);
      const { signal: combinedSignal, cleanup: cleanupCombinedSignal } = combineAbortSignals(timeoutController.signal, options.signal);

      const args = [...options.extraArgs, options.dbPath];

      try {
        return await new Promise<SqliteRunResult>((resolve, reject) => {
          let settled = false;
          const child = execFile(
            SQLITE_BINARY_PATH,
            args,
            {
              env: { ...SQLITE_PROCESS_ENV },
              shell: false,
              windowsHide: true,
              maxBuffer: options.maxOutputBytes,
              signal: combinedSignal,
              encoding: "utf8",
            },
            (error, stdout, stderr) => {
              if (settled) return;
              settled = true;
              if (error) {
                reject(classifyExecFileError(error as NodeExecFileError, timeoutController.signal.aborted, options.signal?.aborted ?? false));
                return;
              }
              resolve({ stdout, stderr });
            },
          );
          if (child.stdin) {
            // A killed/exited child (timeout, cancellation, bad dbPath) can close its stdin pipe
            // before this process finishes writing; without a listener, that EPIPE/ECONNRESET
            // becomes an unhandled 'error' event and crashes the host process. The exec callback
            // above already reports the real failure, so this listener only needs to swallow it.
            child.stdin.on("error", () => {});
            child.stdin.end(options.script, "utf8");
          } else if (!settled) {
            settled = true;
            reject(new SqliteProcessError("spawn-failed", "sqlite3 process has no writable stdin."));
          }
        });
      } finally {
        window.clearTimeout(timeoutHandle);
        cleanupCombinedSignal();
      }
    },
  };
}
