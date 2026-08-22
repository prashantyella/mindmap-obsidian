export const APPLE_BOOKS_READER_TIMEOUT_MS = 60_000;
export const APPLE_BOOKS_READER_TIMEOUT_MESSAGE = "Apple Books reader timed out after 60 seconds.";

export interface ReaderStream {
  on(event: "data", listener: (chunk: unknown) => void): void;
}

export interface ReaderChild {
  stdout: ReaderStream;
  stderr: ReaderStream;
  on(event: "error" | "close", listener: (value?: unknown) => void): void;
  kill(): void;
}

export interface ReaderTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export function startAppleBooksReaderProcess(options: {
  spawn(): ReaderChild;
  timer?: ReaderTimer;
  timeoutMs?: number;
}): { child: ReaderChild; promise: Promise<unknown> } {
  // Wrap the global timers rather than passing them as object properties: in
  // Electron's renderer the native setTimeout/clearTimeout throw "Illegal
  // invocation" unless called with `this === window`, which `{ setTimeout }`
  // shorthand does not preserve. Node has no such requirement, so this only
  // surfaces at runtime inside Obsidian.
  const timer = options.timer ?? {
    setTimeout: (callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle: unknown) => window.clearTimeout(handle as ReturnType<typeof window.setTimeout>),
  };
  const timeoutMs = options.timeoutMs ?? APPLE_BOOKS_READER_TIMEOUT_MS;
  const child = options.spawn();
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timeout: unknown = null;
  const promise = new Promise<unknown>((resolve, reject) => {
    // Split resolve/reject rather than one `settle(outcome, value: unknown)`
    // helper so the reject path is statically typed to accept only an
    // Error, satisfying @typescript-eslint/prefer-promise-reject-errors.
    const settleResolve = (value: unknown): void => {
      if (settled) return;
      settled = true;
      if (timeout !== null) timer.clearTimeout(timeout);
      resolve(value);
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout !== null) timer.clearTimeout(timeout);
      reject(error);
    };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => settleReject(error instanceof Error ? error : new Error("Apple Books reader failed.")));
    child.on("close", (code) => {
      if (code !== 0) {
        settleReject(new Error(stderr.trim() || `Apple Books reader exited with status ${String(code)}.`));
        return;
      }
      const line = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).pop();
      if (!line) {
        settleReject(new Error(stderr.trim() || "Apple Books reader did not produce structured output."));
        return;
      }
      try { settleResolve(JSON.parse(line) as unknown); } catch { settleReject(new Error("Apple Books reader output was not valid JSON.")); }
    });
    timeout = timer.setTimeout(() => {
      child.kill();
      settleReject(new Error(APPLE_BOOKS_READER_TIMEOUT_MESSAGE));
    }, timeoutMs);
  });
  return { child, promise };
}
