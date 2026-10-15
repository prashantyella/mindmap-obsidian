import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { canonicalizePath, stableNoteIdentity } from "./engine/contracts";
import { NodeOwnedFs } from "./engine/nodeFs";
import { JobEngine, type JobPhaseRunner } from "./jobs/jobEngine";
import { JobStore } from "./jobs/jobStore";
import { SidebarRefreshController } from "./sidebarRefreshController";

/**
 * Opt-in Node baseline for queue/controller overhead only (no Obsidian DOM or provider):
 * MINDMAP_RUN_INTERACTION_BENCHMARK=1 npx tsx --import ./scripts/test-setup.mjs --test src/performanceBaseline.test.ts
 */
const RUN_BENCHMARK = process.env.MINDMAP_RUN_INTERACTION_BENCHMARK === "1";

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

function summary(values: readonly number[]): { p50Ms: number; p95Ms: number } {
  return {
    p50Ms: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
  };
}

async function measureSidebarTimer(kind: "lookup" | "note" | "typing-idle", samples = 20): Promise<number[]> {
  const latencies: number[] = [];
  const controllers: SidebarRefreshController[] = [];
  await new Promise<void>((resolve) => {
    for (let index = 0; index < samples; index += 1) {
      let started = 0;
      const record = () => {
        latencies.push(performance.now() - started);
        if (latencies.length === samples) resolve();
      };
      const controller = new SidebarRefreshController({
        runLookup: kind === "lookup" ? record : () => undefined,
        refreshNote: kind === "note" ? record : () => undefined,
        typingEnded: kind === "typing-idle" ? record : () => undefined,
      });
      controllers.push(controller);
      started = performance.now();
      if (kind === "lookup") controller.scheduleLookup();
      else if (kind === "note") controller.scheduleNoteRefresh();
      else controller.recordTyping();
    }
  });
  for (const controller of controllers) controller.close();
  return latencies;
}

void test("opt-in queue and sidebar interaction timing benchmark", { skip: !RUN_BENCHMARK, timeout: 30_000 }, async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mindmap-interaction-benchmark-"));
  try {
    const queueRoot = path.join(root, "queue");
    await fs.promises.mkdir(queueRoot);
    const store = new JobStore(new NodeOwnedFs(queueRoot), queueRoot);
    const startedJobs: string[] = [];
    const runner: JobPhaseRunner = {
      step: async (job) => {
        startedJobs.push(job.job.jobId);
        return { type: "deferred" };
      },
    };
    const engine = new JobEngine(store, { "process-note": runner });
    const jobs = [];
    for (let index = 0; index < 100; index += 1) {
      jobs.push(await engine.submit({
        trigger: "scheduled",
        kind: "process-note",
        identity: stableNoteIdentity(canonicalizePath(`Bench/Note-${index}.md`)),
        sourceHash: index.toString(16).padStart(64, "0"),
        embeddingModel: "benchmark-model",
        pipelineVersion: 1,
      }));
    }
    const priorityDispatchMs: number[] = [];
    for (const job of jobs.slice(-20).reverse()) {
      engine.prioritizeJob(job.job.jobId);
      const started = performance.now();
      await engine.runOnce();
      priorityDispatchMs.push(performance.now() - started);
      assert.equal(startedJobs[startedJobs.length - 1], job.job.jobId);
    }

    const idleRoot = path.join(root, "idle");
    await fs.promises.mkdir(idleRoot);
    const idleEngine = new JobEngine(new JobStore(new NodeOwnedFs(idleRoot), idleRoot), {});
    const idleDispatchMs: number[] = [];
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const started = performance.now();
      assert.equal(await idleEngine.runOnce(), "idle");
      idleDispatchMs.push(performance.now() - started);
    }

    const [lookupMs, noteRefreshMs, typingIdleMs] = await Promise.all([
      measureSidebarTimer("lookup"),
      measureSidebarTimer("note"),
      measureSidebarTimer("typing-idle"),
    ]);
    const output = {
      queue: { fs: "NodeOwnedFs", backlog: jobs.length, priorityDispatch: summary(priorityDispatchMs), idleDispatch: summary(idleDispatchMs) },
      sidebarController: {
        samples: lookupMs.length,
        lookupCallback: summary(lookupMs),
        noteRefreshCallback: summary(noteRefreshMs),
        typingIdleCallback: summary(typingIdleMs),
      },
      runtime: process.version,
      hardware: `${os.cpus()[0]?.model ?? "unknown"}; ${os.cpus().length} logical CPUs; ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GiB RAM`,
      scope: "Node controller/queue timing only; excludes Obsidian DOM, provider, and LLM latency",
    };
    process.stdout.write(`INTERACTION_BENCHMARK ${JSON.stringify(output)}\n`);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
