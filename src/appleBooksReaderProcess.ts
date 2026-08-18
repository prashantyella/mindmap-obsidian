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
  const timer = options.timer ?? { setTimeout, clearTimeout };
  const timeoutMs = options.timeoutMs ?? APPLE_BOOKS_READER_TIMEOUT_MS;
  const child = options.spawn();
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timeout: unknown = null;
  const promise = new Promise<unknown>((resolve, reject) => {
    const settle = (outcome: "resolve" | "reject", value: unknown): void => {
      if (settled) return;
      settled = true;
      if (timeout !== null) timer.clearTimeout(timeout);
      if (outcome === "resolve") resolve(value); else reject(value);
    };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => settle("reject", error instanceof Error ? error : new Error("Apple Books reader failed.")));
    child.on("close", (code) => {
      if (code !== 0) {
        settle("reject", new Error(stderr.trim() || `Apple Books reader exited with status ${String(code)}.`));
        return;
      }
      const line = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).pop();
      if (!line) {
        settle("reject", new Error(stderr.trim() || "Apple Books reader did not produce structured output."));
        return;
      }
      try { settle("resolve", JSON.parse(line) as unknown); } catch { settle("reject", new Error("Apple Books reader output was not valid JSON.")); }
    });
    timeout = timer.setTimeout(() => {
      child.kill();
      settle("reject", new Error(APPLE_BOOKS_READER_TIMEOUT_MESSAGE));
    }, timeoutMs);
  });
  return { child, promise };
}
