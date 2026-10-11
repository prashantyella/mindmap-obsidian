export interface ReplaceableEngine {
  start(): Promise<unknown>;
  dispose(): Promise<void>;
  stop?(): Promise<void>;
  whenJobsSettled?(): Promise<void>;
}

export interface EngineReplacementResult<T extends ReplaceableEngine> {
  engine: T | null;
  activationError: Error | null;
  recoveryError: Error | null;
  recovered: boolean;
  startResult?: unknown;
}

/** Stops the sole active writer before starting a replacement, then rebuilds the prior configuration if activation fails. */
export async function replaceEngineSafely<T extends ReplaceableEngine>(options: {
  current: T | null;
  createNext(): T;
  createRollback?: () => T;
  prepareCurrent?: (current: T) => Promise<void>;
  quiescenceTimeoutMs?: number;
}): Promise<EngineReplacementResult<T>> {
  if (options.current) {
    if (options.prepareCurrent) await options.prepareCurrent(options.current);
    else await prepareReplaceableEngine(options.current, options.quiescenceTimeoutMs);
  }
  let next: T | null = null;
  try {
    next = options.createNext();
    const startResult = await next.start();
    return { engine: next, activationError: null, recoveryError: null, recovered: false, startResult };
  } catch (error) {
    const activationError = toError(error);
    if (next) await prepareReplaceableEngine(next, options.quiescenceTimeoutMs);
    if (!options.createRollback) return { engine: null, activationError, recoveryError: null, recovered: false };
    let rollback: T | null = null;
    try {
      rollback = options.createRollback();
      const startResult = await rollback.start();
      return { engine: rollback, activationError, recoveryError: null, recovered: true, startResult };
    } catch (error) {
      const recoveryError = toError(error);
      if (rollback) await prepareReplaceableEngine(rollback, options.quiescenceTimeoutMs);
      return { engine: null, activationError, recoveryError, recovered: false };
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Engine replacement failed.");
}

export async function prepareReplaceableEngine(engine: ReplaceableEngine, timeoutMs = 30_000): Promise<void> {
  await engine.stop?.();
  if (engine.whenJobsSettled) {
    let timeout: number | undefined;
    try {
      await Promise.race([
        engine.whenJobsSettled(),
        new Promise<never>((_resolve, reject) => {
          timeout = window.setTimeout(() => reject(new Error("Timed out waiting for active Mindmap jobs to settle. No replacement engine was started.")), timeoutMs);
        }),
      ]);
    } catch (error) {
      await engine.dispose();
      throw error;
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }
  }
  await engine.dispose();
}
