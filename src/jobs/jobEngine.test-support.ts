import type { AtomicStoreFs } from "../engine/atomicStore";
import { canonicalizePath, stableNoteIdentity, JOB_KIND_PHASES } from "../engine/contracts";
import { JobEngine, type JobEngineClock, type JobPhaseRunner, type PhaseStepOutcome } from "./jobEngine";
import { JobStore } from "./jobStore";
import type { PersistedJobV1 } from "./jobTypes";

export class FakeFs implements AtomicStoreFs {
  files = new Map<string, string>();
  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }
  async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }
  async rename(fromPath: string, toPath: string): Promise<void> {
    const value = this.files.get(fromPath);
    if (value === undefined) throw new Error(`ENOENT: ${fromPath}`);
    this.files.delete(fromPath);
    this.files.set(toPath, value);
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async readdir(dirPath: string): Promise<string[]> {
    const prefix = `${dirPath}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) names.add(key.slice(prefix.length));
    }
    return [...names];
  }
}

export class FakeClock implements JobEngineClock {
  ms = 1_000_000;
  now(): number {
    return this.ms;
  }
}

/** Advances a job through every phase for its kind, one "advance" per call, then "complete". */
export function linearAdvanceScript(kind: "process-note" | "rebuild-index" | "migrate-index") {
  return (job: PersistedJobV1): PhaseStepOutcome => {
    const phases = JOB_KIND_PHASES[kind];
    const index = phases.indexOf(job.job.phase);
    const next = phases[index + 1];
    if (next === undefined || job.job.phase === "complete") return { type: "complete" };
    if (index === phases.length - 2) return { type: "complete" };
    return { type: "advance", nextPhase: next };
  };
}

export function makeEngine(runners: Partial<Record<"process-note" | "rebuild-index" | "migrate-index", JobPhaseRunner>>, clock = new FakeClock()) {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const engine = new JobEngine(store, runners, clock);
  return { store, engine, clock };
}

export function noteIdentity(path: string) {
  return stableNoteIdentity(canonicalizePath(path));
}
