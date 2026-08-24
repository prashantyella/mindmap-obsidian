import { execFile } from "node:child_process";
import fs from "node:fs";

import type { LegacyLaunchAgentCleanupFs } from "../launchAgent";
import type { BackgroundSchedulerFs, ProcessResult, ProcessRunner } from "./backgroundScheduler";

const PROCESS_TIMEOUT_MS = 10_000;
const PROCESS_KILL_GRACE_MS = 1_000;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function identityOf(stat: fs.BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

/** No-follow, bounded, identity-capturing filesystem seam for retiring legacy LaunchAgents. */
export function createNodeLegacyLaunchAgentCleanupFs(): LegacyLaunchAgentCleanupFs {
  return {
    exists: async (filePath) => {
      try {
        await fs.promises.lstat(filePath);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return false;
        throw error;
      }
    },
    readBoundedWithIdentity: async (filePath, maxBytes) => {
      let handle: fs.promises.FileHandle | null = null;
      try {
        handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | O_NOFOLLOW);
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.size < 0n || before.size > BigInt(maxBytes)) return null;
        const buffer = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (bytesRead <= 0) return null;
          offset += bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const identity = identityOf(before);
        if (identityOf(after) !== identity) return null;
        return { contents: buffer.toString("utf8"), identity };
      } catch {
        return null;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
    matchesIdentity: async (filePath, identity) => {
      try {
        const stat = await fs.promises.lstat(filePath, { bigint: true });
        return stat.isFile() && identityOf(stat) === identity;
      } catch {
        return false;
      }
    },
    rename: (fromPath, toPath) => fs.promises.rename(fromPath, toPath),
  };
}

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
        let timedOut = false;
        let escalationId: number | null = null;
        const child = execFile(executablePath, [...argv], { maxBuffer: 256 * 1024, shell: false }, (error, stdout, stderr) => {
          window.clearTimeout(timeoutId);
          if (escalationId !== null) window.clearTimeout(escalationId);
          const rawCode = (error as (Error & { code?: unknown }) | null)?.code;
          const code = error === null ? 0 : typeof rawCode === "number" ? rawCode : 1;
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), timedOut });
        });
        const timeoutId = window.setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          escalationId = window.setTimeout(() => child.kill("SIGKILL"), PROCESS_KILL_GRACE_MS);
        }, PROCESS_TIMEOUT_MS);
      }),
  };
}
