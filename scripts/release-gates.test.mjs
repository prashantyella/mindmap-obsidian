import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

void test("CI and publication cannot bypass unit/integration gates or silently make them optional", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.test, "node scripts/test-runner.mjs all");
  assert.equal(pkg.scripts["test:unit"], "node scripts/test-runner.mjs unit");
  assert.equal(pkg.scripts["test:release"], "node scripts/test-runner.mjs integration");
  assert.ok(pkg.scripts.check.split(" && ").includes("npm test"));
  assert.equal(pkg.scripts["release:prepare"].split(" && ")[0], "npm run test:release");
  for (const [file, jobName, integrationCommand] of [
    ["ci.yml", "verify", "npm run test:release"],
    ["release.yml", "build", "npm run release:prepare"],
  ]) {
    const workflow = parse(await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
    const job = workflow.jobs[jobName];
    assert.equal(job.if, undefined);
    assert.equal(job["continue-on-error"], undefined);
    const indices = ["npm run test:unit", integrationCommand].map(command => {
      const index = job.steps.findIndex(step => step.run === command);
      assert.ok(index >= 0, `${file} must run ${command}`);
      assert.equal(job.steps[index].if, undefined);
      assert.equal(job.steps[index]["continue-on-error"], undefined);
      return index;
    });
    const publish = job.steps.findIndex(step => step.uses?.startsWith("softprops/action-gh-release@"));
    if (file === "release.yml") assert.ok(publish > Math.max(...indices), "publication must come after both gates");
  }
});
