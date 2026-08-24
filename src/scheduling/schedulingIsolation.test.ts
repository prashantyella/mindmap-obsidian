import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * Checkpoint 8's isolation guards, mirroring `src/jobs/jobsIsolation.test.ts`
 * field-for-field:
 *  - "core" (`scheduleTypes.ts`/`scheduleTime.ts`/`scheduleStore.ts`/
 *    `coreScheduler.ts`) must never import Obsidian, `main.ts`, or the
 *    background/launchd adapter -- the optional adapter must be removable
 *    with zero effect on core scheduling (requirement 6's last bullet).
 *  - "background" (`backgroundScheduler.ts`) must never import a job kind,
 *    the index, a provider interface, or any vault-content module -- it
 *    only ever wakes/opens the vault, never decides or performs work.
 * Neither file may contain a literal control byte, invoke a shell, or spawn
 * a live subprocess/network call anywhere in this module (only the
 * INJECTED `ProcessRunner`/`AtomicStoreFs`/`IntervalRegistrar` seams may
 * ever reach a real OS primitive, and only in a later checkpoint's
 * production wiring, never here).
 */

const SCHEDULING_DIR = __dirname;
const CORE_FILES = ["scheduleTypes.ts", "scheduleTime.ts", "scheduleStore.ts", "coreScheduler.ts"];
const BACKGROUND_FILES = ["backgroundScheduler.ts"];

function readSource(fileName: string): string {
  return fs.readFileSync(path.join(SCHEDULING_DIR, fileName), "utf8");
}

const CORE_FORBIDDEN_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "obsidian runtime", pattern: /from\s+["']obsidian["']/ },
  { label: "main.ts", pattern: /from\s+["'][^"']*\bmain["']/ },
  { label: "background/launchd adapter", pattern: /backgroundScheduler|launchctl|LaunchAgent/i },
  { label: "Python subprocess", pattern: /child_process|execFile|spawn\(/ },
  { label: "requestUrl (Obsidian network API)", pattern: /requestUrl/ },
  { label: "raw fetch call", pattern: /(?<!\/\/.*)\bfetch\(/ },
];

void test("src/scheduling core files (scheduleTypes/scheduleTime/scheduleStore/coreScheduler) never import Obsidian, main.ts, or the background adapter", () => {
  for (const fileName of CORE_FILES) {
    const content = readSource(fileName);
    for (const { label, pattern } of CORE_FORBIDDEN_PATTERNS) {
      assert.doesNotMatch(content, pattern, `${fileName} matched forbidden pattern for "${label}"`);
    }
  }
});

const BACKGROUND_FORBIDDEN_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "obsidian runtime", pattern: /from\s+["']obsidian["']/ },
  { label: "main.ts", pattern: /from\s+["'][^"']*\bmain["']/ },
  { label: "job kind/job engine/job store", pattern: /from\s+["'][^"']*\/jobs\// },
  { label: "index/vector store", pattern: /from\s+["'][^"']*\/index\// },
  { label: "reading/vault-content module", pattern: /from\s+["'][^"']*\/reading\// },
  { label: "Python subprocess (real child_process usage)", pattern: /require\(["']child_process["']\)|from\s+["']child_process["']/ },
  { label: "shell invocation", pattern: /\bshell\s*:\s*true/ },
  { label: "localhost/loopback IPC", pattern: /127\.0\.0\.1|localhost/i },
  { label: "raw fetch/requestUrl network call", pattern: /(?<!\/\/.*)\bfetch\(|requestUrl/ },
];

void test("src/scheduling/backgroundScheduler.ts never imports a job kind, the index, a provider interface, or a vault-content module, and never opens a shell/localhost IPC channel", () => {
  for (const fileName of BACKGROUND_FILES) {
    const content = readSource(fileName);
    for (const { label, pattern } of BACKGROUND_FORBIDDEN_PATTERNS) {
      assert.doesNotMatch(content, pattern, `${fileName} matched forbidden pattern for "${label}"`);
    }
  }
});

void test("backgroundScheduler.ts's own process seam always builds a fixed argv array -- no string-concatenated command anywhere in the file", () => {
  const content = readSource("backgroundScheduler.ts");
  assert.doesNotMatch(content, /exec\(/); // exec() takes a shell string; only execFile-style fixed-argv APIs are permitted at a real call site
});

void test("esbuild's declared entry point does not directly name any src/scheduling module (composition happens later, in main.ts)", () => {
  const esbuildConfig = fs.readFileSync(path.join(SCHEDULING_DIR, "../..", "esbuild.config.mjs"), "utf8");
  for (const fileName of [...CORE_FILES, ...BACKGROUND_FILES]) {
    assert.doesNotMatch(esbuildConfig, new RegExp(fileName.replace(".", "\\.")));
  }
});

void test("no src/scheduling/*.ts source file contains a literal control byte (other than tab/LF/CR)", () => {
  const ALLOWED_CONTROL_BYTES = new Set<number>([0x09, 0x0a, 0x0d]);
  const files = fs.readdirSync(SCHEDULING_DIR).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0, "expected to find .ts files in src/scheduling");

  const offenders: string[] = [];
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(SCHEDULING_DIR, file));
    for (let i = 0; i < bytes.length; i += 1) {
      const byte = bytes[i];
      const isControl = byte <= 0x1f || byte === 0x7f;
      if (isControl && !ALLOWED_CONTROL_BYTES.has(byte)) {
        offenders.push(`${file}@${i}: 0x${byte.toString(16).padStart(2, "0")}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `found literal control byte(s): ${offenders.join(", ")}`);
});

void test("no src/scheduling/*.ts source file (other than test doubles) stores note body/prompt/vector/secret-shaped field names directly on persisted schedule/plist state", () => {
  const FORBIDDEN_FIELD_NAME_PATTERN = /\b(rawContent|noteBody|promptText|apiKey|vectorValues|responseBody|notePath)\s*:/;
  const files = fs.readdirSync(SCHEDULING_DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  for (const fileName of files) {
    const content = readSource(fileName);
    assert.doesNotMatch(content, FORBIDDEN_FIELD_NAME_PATTERN, `${fileName} appears to reference a content/secret-shaped field name`);
  }
});

void test("coreScheduler.ts's only src/jobs dependency is the narrow SubmitJobInput type from jobEngine.ts -- never jobStore.ts/jobTypes.ts/a runner module directly", () => {
  const content = readSource("coreScheduler.ts");
  const jobsImports = [...content.matchAll(/from\s+["'](\.\.\/jobs\/[^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(jobsImports, ["../jobs/jobEngine"]);
});
