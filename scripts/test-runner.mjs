import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Deterministic, shell-free discovery works on all supported desktop platforms. */
export async function discoverTests(root, suffixes) {
  const found = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile() && suffixes.some(suffix => entry.name.endsWith(suffix))) found.push(candidate);
    }
  }
  await walk(root);
  return found.sort();
}

/** A release gate with zero tests, skipped tests, or missing TAP totals fails
 * closed even when Node itself returns success. Unit benchmarks may opt out. */
export async function executeTests(files, { allowSkipped = false, output = text => process.stdout.write(text), error = text => process.stderr.write(text) } = {}) {
  if (files.length === 0) { error("No tests discovered; refusing an empty gate.\n"); return 1; }
  return new Promise(resolve => {
    const childEnvironment = { ...process.env };
    // This is a new runner process, including when testing the gate itself.
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--import", "tsx", "--import", "./scripts/test-setup.mjs", "--test", "--test-reporter=tap", ...files], {
      cwd: repository, env: childEnvironment, stdio: ["ignore", "pipe", "pipe"], shell: false,
    });
    let tail = "";
    let partialLine = "";
    let fileOnlyTest = false;
    const filePaths = new Set(files.map(file => path.resolve(repository, file)));
    child.stdout.on("data", bytes => {
      const text = bytes.toString();
      output(text);
      tail = (tail + text).slice(-16_384);
      const lines = (partialLine + text).split("\n");
      partialLine = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("# Subtest: ") && filePaths.has(line.slice(11).trim())) fileOnlyTest = true;
      }
    });
    child.stderr.on("data", bytes => error(bytes.toString()));
    child.once("error", cause => { error(`${cause.message}\n`); resolve(1); });
    child.once("close", code => {
      if (code !== 0) { resolve(code ?? 1); return; }
      const tests = [...tail.matchAll(/^# tests (\d+)\s*$/gm)].at(-1);
      const skipped = [...tail.matchAll(/^# skipped (\d+)\s*$/gm)].at(-1);
      const todo = [...tail.matchAll(/^# todo (\d+)\s*$/gm)].at(-1);
      if (!tests || Number(tests[1]) === 0 || !skipped || !todo || (!allowSkipped && (fileOnlyTest || Number(skipped[1]) > 0 || Number(todo[1]) > 0))) {
        error("Gate failed: missing totals, no tests, or skipped/TODO integration tests.\n");
        resolve(1);
      } else resolve(0);
    });
  });
}

async function main(mode) {
  if (!["unit", "integration", "all"].includes(mode)) throw new Error("Usage: node scripts/test-runner.mjs unit|integration|all");
  if (mode !== "integration") {
    const unit = (await Promise.all(["src", "scripts"].map(folder => discoverTests(path.join(repository, folder), [".test.ts", ".test.mjs"])))).flat().sort();
    const result = await executeTests(unit, { allowSkipped: true });
    if (result !== 0) return result;
  }
  if (mode !== "unit") return executeTests(await discoverTests(path.join(repository, "src"), [".integration.ts"]));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv[2] ?? "all");
}
