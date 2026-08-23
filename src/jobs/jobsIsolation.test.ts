import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * Checkpoint 7 requirement: `src/jobs` must never import `main.ts`, an
 * Obsidian/UI module, a scheduler, a vault-implementation seam, or a
 * subprocess/Python API -- every effect stays behind an injected seam
 * (`AtomicStoreFs`, `NoteWriter`, `IndexFs`/`IndexStore`, the
 * embedding/metadata provider interfaces), and nothing in this directory
 * makes a live network/process call. Production wiring (constructing the
 * real seams and handing them to `JobEngine`) is a later checkpoint's job.
 */
const JOBS_DIR = __dirname;

const FORBIDDEN_IMPORT_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "obsidian runtime", pattern: /from\s+["']obsidian["']/ },
  { label: "main.ts", pattern: /from\s+["'][^"']*\bmain["']/ },
  { label: "scheduler", pattern: /from\s+["'][^"']*[Ss]cheduler["']/ },
  { label: "Python subprocess", pattern: /child_process|execFile|spawn\(/ },
  { label: "Chroma", pattern: /chroma/i },
  { label: "requestUrl (Obsidian network API)", pattern: /requestUrl/ },
  { label: "raw fetch call", pattern: /(?<!\/\/.*)\bfetch\(/ },
];

function listSourceFiles(): string[] {
  return fs
    .readdirSync(JOBS_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".test-support.ts"));
}

void test("src/jobs/*.ts never imports main.ts, obsidian, a scheduler, Chroma, or a subprocess/network API", () => {
  for (const fileName of listSourceFiles()) {
    const content = fs.readFileSync(path.join(JOBS_DIR, fileName), "utf8");
    for (const { label, pattern } of FORBIDDEN_IMPORT_PATTERNS) {
      assert.doesNotMatch(content, pattern, `${fileName} matched forbidden pattern for "${label}"`);
    }
  }
});

void test("esbuild's declared entry point does not directly name any src/jobs module (composition happens later, in main.ts)", () => {
  const esbuildConfig = fs.readFileSync(path.join(JOBS_DIR, "../..", "esbuild.config.mjs"), "utf8");
  for (const fileName of listSourceFiles()) {
    assert.doesNotMatch(esbuildConfig, new RegExp(fileName.replace(".", "\\.")));
  }
});

void test("no src/jobs/*.ts source file contains a literal control byte (other than tab/LF/CR)", () => {
  const ALLOWED_CONTROL_BYTES = new Set<number>([0x09, 0x0a, 0x0d]);
  const files = fs.readdirSync(JOBS_DIR).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0, "expected to find .ts files in src/jobs");

  const offenders: string[] = [];
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(JOBS_DIR, file));
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

void test("no src/jobs/*.ts source file (other than test doubles) stores note body/prompt/vector/secret-shaped field names directly on the persisted job record", () => {
  // A structural guard, not a semantic proof: PersistedJobV1/JobReceiptV1's own field lists are
  // the actual contract (see jobTypes.ts), but a few obviously-wrong field NAMES appearing in the
  // non-test source at all would already indicate someone started plumbing content through.
  const FORBIDDEN_FIELD_NAME_PATTERN = /\b(rawContent|noteBody|promptText|apiKey|vectorValues|responseBody)\s*:/;
  for (const fileName of listSourceFiles()) {
    if (fileName === "noteJob.ts") continue; // legitimately references rawContent as an in-memory (never persisted) local variable type
    const content = fs.readFileSync(path.join(JOBS_DIR, fileName), "utf8");
    assert.doesNotMatch(content, FORBIDDEN_FIELD_NAME_PATTERN, `${fileName} appears to reference a content/secret-shaped field name`);
  }
});
