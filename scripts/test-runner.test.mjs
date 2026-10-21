import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverTests, executeTests } from "./test-runner.mjs";

void test("test discovery is sorted, includes nested/space paths, and separates integration from unit files", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "mindmap-test-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "with spaces"));
  for (const name of ["z.test.ts", "a.integration.ts", "with spaces/b.test.mjs", "helper.ts"]) await writeFile(path.join(root, name), "");
  assert.deepEqual(await discoverTests(root, [".test.ts", ".test.mjs"]), [path.join(root, "with spaces/b.test.mjs"), path.join(root, "z.test.ts")].sort());
  assert.deepEqual(await discoverTests(root, [".integration.ts"]), [path.join(root, "a.integration.ts")]);
});

void test("release test gate rejects empty, skipped, TODO and failing suites; successful suites pass", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "mindmap-test-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let diagnostics = "";
  const silent = { output: text => { diagnostics += text; }, error: text => { diagnostics += text; } };
  assert.equal(await executeTests([], silent), 1);
  for (const [name, body, expected] of [
    ["pass", 'test("passes", () => {});', 0],
    ["skip", 'test.skip("skipped", () => {});', 1],
    ["todo", 'test.todo("unfinished");', 1],
    ["fail", 'test("fails", () => { throw new Error("synthetic failure"); });', 1],
    ["empty", '', 1],
  ]) {
    const file = path.join(root, `${name}.test.mjs`);
    await writeFile(file, `import test from "node:test";\n${body}\n`);
    diagnostics = "";
    assert.equal(await executeTests([file], silent), expected, `${name}: ${diagnostics}`);
  }
  assert.equal(await executeTests([path.join(root, "skip.test.mjs")], { ...silent, allowSkipped: true }), 0, "optional unit benchmarks may remain skipped");
});
