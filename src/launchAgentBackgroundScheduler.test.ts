import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNodeBackgroundSchedulerFs, createNodeBackgroundSchedulerProcessRunner } from "./scheduling/backgroundSchedulerNodeAdapters";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

// ---------------------------------------------------------------------------
// Checkpoint 10B LAUNCHAGENT: source audit -- main.ts's LaunchAgent path must
// never again construct a Python-executing plist. These assert stable
// structural patterns against the real shipped source, never a line number.
// ---------------------------------------------------------------------------

void test("source audit: main.ts never references the retired Python-command LaunchAgent builder", () => {
  const mainSource = readSource("src/main.ts");
  assert.doesNotMatch(mainSource, /buildPluginLaunchAgentSpecs/, "main.ts must never call the Python-command LaunchAgent spec builder again");
  assert.doesNotMatch(mainSource, /getLaunchAgentSpecs/, "main.ts must never build a LaunchAgent spec with a Python command again");
});

void test("source audit: main.ts's LaunchAgent reconciliation drives the accepted TS BackgroundScheduler adapter, not launchctl bootstrap directly", () => {
  const mainSource = readSource("src/main.ts");
  assert.match(mainSource, /backgroundScheduler\.reconcile\(/, "reconcileLaunchAgents must call BackgroundScheduler.reconcile()");
  assert.match(mainSource, /backgroundScheduler\.remove\(/, "disableManagedLaunchAgents must call BackgroundScheduler.remove()");
  assert.doesNotMatch(mainSource, /execFile\(\s*"\/bin\/launchctl"/, "main.ts must not directly shell out to launchctl anymore -- that now lives only inside BackgroundScheduler");
});

void test("source audit: main.ts seeds CoreScheduler's daily-maintenance/weekly-refresh/reading-sync schedules so due TS work runs once Obsidian is open", () => {
  const mainSource = readSource("src/main.ts");
  assert.match(mainSource, /coreScheduler\.configure\(/);
  assert.match(mainSource, /"daily-maintenance"/);
  assert.match(mainSource, /"weekly-refresh"/);
  assert.match(mainSource, /"reading-sync"/);
});

// ---------------------------------------------------------------------------
// Node adapters: fixed-argv-only process runner, no shell.
// ---------------------------------------------------------------------------

void test("createNodeBackgroundSchedulerProcessRunner never uses a shell and returns the real exit code/stdout/stderr", async () => {
  const runner = createNodeBackgroundSchedulerProcessRunner();
  const result = await runner.run(process.execPath, ["-e", "process.stdout.write('hi'); process.exit(0);"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "hi");
});

void test("createNodeBackgroundSchedulerProcessRunner reports a non-zero exit code without throwing", async () => {
  const runner = createNodeBackgroundSchedulerProcessRunner();
  const result = await runner.run(process.execPath, ["-e", "process.exit(3);"]);
  assert.equal(result.code, 3);
});

// ---------------------------------------------------------------------------
// Node adapters: bounded fs seam round-trips real files.
// ---------------------------------------------------------------------------

void test("createNodeBackgroundSchedulerFs round-trips write/read/statSize/exists/unlink against a real temp file", async () => {
  const fsAdapter = createNodeBackgroundSchedulerFs();
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mindmap-bg-scheduler-test-"));
  const target = path.join(tempDir, "owned.plist");
  try {
    assert.equal(await fsAdapter.exists(target), false);
    assert.equal(await fsAdapter.statSize(target), null);

    await fsAdapter.writeFile(target, "<plist/>");
    assert.equal(await fsAdapter.exists(target), true);
    assert.equal(await fsAdapter.statSize(target), Buffer.byteLength("<plist/>", "utf8"));
    assert.equal(await fsAdapter.readFile(target), "<plist/>");

    const renamed = path.join(tempDir, "owned-renamed.plist");
    await fsAdapter.rename(target, renamed);
    assert.equal(await fsAdapter.exists(target), false);
    assert.equal(await fsAdapter.exists(renamed), true);

    await fsAdapter.unlink(renamed);
    assert.equal(await fsAdapter.exists(renamed), false);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});
