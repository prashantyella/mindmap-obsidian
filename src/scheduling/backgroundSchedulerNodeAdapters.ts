import { execFile } from "node:child_process";
import fs from "node:fs";

import type { BackgroundSchedulerFs, ProcessResult, ProcessRunner } from "./backgroundScheduler";

/** Real, plugin-runtime-owned `BackgroundSchedulerFs` -- `node:fs/promises` only, no shell, exactly the bounded surface `BackgroundScheduler` itself needs to read/write/verify its own owned plist. */
export function createNodeBackgroundSchedulerFs(): BackgroundSchedulerFs {
  return {
    readFile: (path) => fs.promises.readFile(path, "utf8"),
    writeFile: (path, contents) => fs.promises.writeFile(path, contents, "utf8"),
    rename: (fromPath, toPath) => fs.promises.rename(fromPath, toPath),
    unlink: (path) => fs.promises.unlink(path),
    exists: async (path) => {
      try {
        await fs.promises.access(path);
        return true;
      } catch {
        return false;
      }
    },
    statSize: async (path) => {
      try {
        const stat = await fs.promises.stat(path);
        return stat.size;
      } catch {
        return null;
      }
    },
    fsync: async (path) => {
      const handle = await fs.promises.open(path, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
}

/**
 * Real, fixed-argv-only `ProcessRunner` -- `execFile` (never `exec`/`spawn`
 * with `shell: true`), matching `BackgroundScheduler`'s own documented
 * contract that every call site builds a complete argv array itself. Bounds
 * captured stdout/stderr the same way every other `execFile`-based adapter
 * in this codebase does (`maxBuffer`), and never rejects on a non-zero
 * exit -- `BackgroundScheduler` itself interprets `code`/`stdout`/`stderr`.
 */
export function createNodeBackgroundSchedulerProcessRunner(): ProcessRunner {
  return {
    run: (executablePath, argv) =>
      new Promise<ProcessResult>((resolve) => {
        execFile(executablePath, [...argv], { maxBuffer: 256 * 1024, shell: false }, (error, stdout, stderr) => {
          const rawCode = (error as (Error & { code?: unknown }) | null)?.code;
          const code = error === null ? 0 : typeof rawCode === "number" ? rawCode : 1;
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        });
      }),
  };
}
