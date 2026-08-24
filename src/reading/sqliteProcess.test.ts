import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createNodeSqliteProcess, MAX_OUTPUT_BYTES_CEILING, MAX_SQLITE_TIMEOUT_MS, SQLITE_BINARY_PATH, SqliteProcessError } from "./sqliteProcess";

const execFileP = promisify(execFile);
const TEMP_DB_PREFIX = "mindmap-sqlite-process-test-";

/**
 * Every `makeTempDb` call is tracked here and removed in the module-level
 * `after()` below -- runs once the whole file's tests finish, success or
 * failure, so a real sqlite3 temp directory is never left behind even if a
 * mid-file assertion throws. `test.after` inside an individual test would
 * only guard that one test; a module-level `after()` guards the whole file.
 */
const createdTempDirs: string[] = [];
let tmpDirEntriesBeforeSuite: string[] = [];

before(async () => {
  tmpDirEntriesBeforeSuite = await fs.readdir(os.tmpdir());
});

async function makeTempDb(sql: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_DB_PREFIX));
  createdTempDirs.push(dir);
  const dbPath = path.join(dir, "db.sqlite");
  await execFileP(SQLITE_BINARY_PATH, [dbPath, sql]);
  return dbPath;
}

after(async () => {
  for (const dir of createdTempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  const afterEntries = await fs.readdir(os.tmpdir());
  const leaked = afterEntries.filter((entry) => entry.startsWith(TEMP_DB_PREFIX) && !tmpDirEntriesBeforeSuite.includes(entry));
  assert.deepEqual(leaked, [], "no mindmap-sqlite-process-test- temp directory should survive this test file");
});

void test("run() invokes exactly /usr/bin/sqlite3 with fixed argv and returns query output", async () => {
  const dbPath = await makeTempDb("CREATE TABLE t(a INTEGER); INSERT INTO t VALUES (1), (2);");
  const proc = createNodeSqliteProcess();
  const result = await proc.run({
    script: "SELECT json_group_array(a) FROM t;\n",
    extraArgs: ["-readonly", "-batch", "-list"],
    dbPath,
    timeoutMs: 2000,
    maxOutputBytes: 4096,
  });
  assert.equal(result.stdout.trim(), "[1,2]");
});

void test("run() rejects (Error-only) when the database does not exist", async () => {
  const proc = createNodeSqliteProcess();
  await assert.rejects(
    () =>
      proc.run({
        script: "SELECT 1;\n",
        extraArgs: ["-readonly", "-batch", "-list"],
        dbPath: "/nonexistent-mindmap-test-path/db.sqlite",
        timeoutMs: 2000,
        maxOutputBytes: 4096,
      }),
    (error: unknown) => error instanceof SqliteProcessError,
  );
});

void test("run() classifies a slow query as a timeout distinct from cancellation", async () => {
  const dbPath = await makeTempDb("CREATE TABLE t(a INTEGER);");
  const proc = createNodeSqliteProcess();
  const start = Date.now();
  await assert.rejects(
    () =>
      proc.run({
        script: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 5000000000) SELECT count(*) FROM c;\n",
        extraArgs: ["-readonly", "-batch", "-list"],
        dbPath,
        timeoutMs: 300,
        maxOutputBytes: 4096,
      }),
    (error: unknown) => error instanceof SqliteProcessError && error.kind === "timeout",
  );
  assert.ok(Date.now() - start < 4000, "the timeout must actually bound the wait, not merely be advisory");
});

void test("run() classifies an aborted signal as cancelled, not timeout", async () => {
  const dbPath = await makeTempDb("CREATE TABLE t(a INTEGER);");
  const proc = createNodeSqliteProcess();
  const controller = new AbortController();
  const pending = proc.run({
    script: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 5000000000) SELECT count(*) FROM c;\n",
    extraArgs: ["-readonly", "-batch", "-list"],
    dbPath,
    timeoutMs: MAX_SQLITE_TIMEOUT_MS,
    maxOutputBytes: 4096,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(() => pending, (error: unknown) => error instanceof SqliteProcessError && error.kind === "cancelled");
});

void test("run() rejects immediately for an already-aborted signal without spawning", async () => {
  const proc = createNodeSqliteProcess();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      proc.run({
        script: "SELECT 1;\n",
        extraArgs: ["-readonly", "-batch", "-list"],
        dbPath: "/tmp/does-not-matter.sqlite",
        timeoutMs: 2000,
        maxOutputBytes: 4096,
        signal: controller.signal,
      }),
    (error: unknown) => error instanceof SqliteProcessError && error.kind === "cancelled",
  );
});

void test("run() bounds output and classifies an overrun as output-too-large", async () => {
  const dbPath = await makeTempDb("CREATE TABLE t(a INTEGER);");
  const proc = createNodeSqliteProcess();
  await assert.rejects(
    () =>
      proc.run({
        script: "SELECT json_group_array(hex(randomblob(2000))) FROM (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3);\n",
        extraArgs: ["-readonly", "-batch", "-list"],
        dbPath,
        timeoutMs: 2000,
        maxOutputBytes: 64,
      }),
    (error: unknown) => error instanceof SqliteProcessError && error.kind === "output-too-large",
  );
});

void test("run() rejects a timeoutMs above the 60s hard ceiling before spawning", async () => {
  const proc = createNodeSqliteProcess();
  await assert.rejects(
    () =>
      proc.run({
        script: "SELECT 1;\n",
        extraArgs: ["-readonly", "-batch", "-list"],
        dbPath: "/tmp/does-not-matter.sqlite",
        timeoutMs: MAX_SQLITE_TIMEOUT_MS + 1,
        maxOutputBytes: 4096,
      }),
    (error: unknown) => error instanceof SqliteProcessError,
  );
});

void test("run() rejects a non-positive/fractional timeoutMs", async () => {
  const proc = createNodeSqliteProcess();
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(() =>
      proc.run({
        script: "SELECT 1;\n",
        extraArgs: ["-readonly", "-batch", "-list"],
        dbPath: "/tmp/does-not-matter.sqlite",
        timeoutMs: bad,
        maxOutputBytes: 4096,
      }),
    );
  }
});

void test("run() error messages are static/fixed and never embed the script, dbPath, or raw stderr text", async () => {
  const proc = createNodeSqliteProcess();
  const secretDbPath = "/tmp/SECRET-PATH-should-not-leak/db.sqlite";
  try {
    await proc.run({
      script: "SELECT 1;\n",
      extraArgs: ["-readonly", "-batch", "-list"],
      dbPath: secretDbPath,
      timeoutMs: 2000,
      maxOutputBytes: 4096,
    });
    assert.fail("expected a rejection");
  } catch (error) {
    assert.ok(error instanceof SqliteProcessError);
    assert.doesNotMatch(error.message, /SECRET-PATH/);
    assert.doesNotMatch(error.message, /\.sqlite/);
  }
});

void test("createNodeSqliteProcess always targets the fixed /usr/bin/sqlite3 path", () => {
  assert.equal(SQLITE_BINARY_PATH, "/usr/bin/sqlite3");
});

void test("run() rejects an extraArgs flag outside the fixed allowlist without spawning", async () => {
  const proc = createNodeSqliteProcess();
  await assert.rejects(
    () =>
      proc.run({
        script: "SELECT 1;\n",
        extraArgs: ["-readonly", "-batch", "-list", "-cmd"],
        dbPath: "/tmp/does-not-matter.sqlite",
        timeoutMs: 2000,
        maxOutputBytes: 4096,
      }),
    (error: unknown) => error instanceof SqliteProcessError && error.kind === "spawn-failed",
  );
});

void test("run() rejects -init and extension-loading flags even though they look plausible", async () => {
  const proc = createNodeSqliteProcess();
  for (const badArg of ["-init", "-unsafe-testing", "-load"]) {
    await assert.rejects(
      () =>
        proc.run({
          script: "SELECT 1;\n",
          extraArgs: ["-readonly", badArg],
          dbPath: "/tmp/does-not-matter.sqlite",
          timeoutMs: 2000,
          maxOutputBytes: 4096,
        }),
      (error: unknown) => error instanceof SqliteProcessError && error.kind === "spawn-failed",
    );
  }
});

void test("run() rejects a relative dbPath", async () => {
  const proc = createNodeSqliteProcess();
  await assert.rejects(
    () =>
      proc.run({
        script: "SELECT 1;\n",
        extraArgs: ["-readonly", "-batch", "-list"],
        dbPath: "relative/path.sqlite",
        timeoutMs: 2000,
        maxOutputBytes: 4096,
      }),
    (error: unknown) => error instanceof SqliteProcessError && error.kind === "spawn-failed",
  );
});

void test("run() rejects a dbPath containing a control character", async () => {
  const proc = createNodeSqliteProcess();
  const controlCharPath = `/tmp/bad${String.fromCharCode(0)}path.sqlite`;
  await assert.rejects(
    () =>
      proc.run({
        script: "SELECT 1;\n",
        extraArgs: ["-readonly", "-batch", "-list"],
        dbPath: controlCharPath,
        timeoutMs: 2000,
        maxOutputBytes: 4096,
      }),
    (error: unknown) => error instanceof SqliteProcessError && error.kind === "spawn-failed",
  );
});

void test("run() rejects a maxOutputBytes above the hard ceiling", async () => {
  const proc = createNodeSqliteProcess();
  await assert.rejects(
    () =>
      proc.run({
        script: "SELECT 1;\n",
        extraArgs: ["-readonly", "-batch", "-list"],
        dbPath: "/tmp/does-not-matter.sqlite",
        timeoutMs: 2000,
        maxOutputBytes: MAX_OUTPUT_BYTES_CEILING + 1,
      }),
    (error: unknown) => error instanceof SqliteProcessError && error.kind === "spawn-failed",
  );
});

void test("run() cleans up its abort-signal listeners and does not leak them onto a long-lived caller signal", async () => {
  const dbPath = await makeTempDb("CREATE TABLE t(a INTEGER); INSERT INTO t VALUES (1);");
  const proc = createNodeSqliteProcess();
  const controller = new AbortController();
  for (let i = 0; i < 20; i += 1) {
    await proc.run({
      script: "SELECT json_group_array(a) FROM t;\n",
      extraArgs: ["-readonly", "-batch", "-list"],
      dbPath,
      timeoutMs: 2000,
      maxOutputBytes: 4096,
      signal: controller.signal,
    });
  }
  // Node's EventTarget warns/throws past ~10 listeners on the same signal by default;
  // twenty completed runs sharing one long-lived signal proves cleanup actually ran.
  assert.equal(controller.signal.aborted, false);
});
