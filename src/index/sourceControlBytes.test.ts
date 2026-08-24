import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * Source-level audit: no `.ts` file in `src/index/` may contain a literal
 * control byte (C0 range 0x00-0x1F, or DEL 0x7F), other than tab/LF/CR.
 * `indexManifest.ts` previously carried a regex literal
 * (`/[\x00-\x1f\x7f]/`) whose *compiled source on disk* ended up
 * containing actual NUL/US/DEL bytes rather than the intended escaped
 * text -- a toolchain step along the way interpreted the escape sequences
 * instead of leaving them as literal backslash-x-hex text. That control
 * validation now uses `String.prototype.charCodeAt` codepoint comparison
 * instead of a regex literal (see `indexManifest.ts`'s
 * `hasControlCharacter`), which cannot regress into shipping a literal
 * control byte. This test is the standing guard against that whole class
 * of regression, for every file in this directory, not just the one that
 * already hit it.
 */

const SRC_INDEX_DIR = __dirname;
const ALLOWED_CONTROL_BYTES = new Set<number>([0x09, 0x0a, 0x0d]); // tab, LF, CR

void test("no src/index/*.ts source file contains a literal control byte (other than tab/LF/CR)", () => {
  const files = fs.readdirSync(SRC_INDEX_DIR).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0, "expected to find .ts files in src/index");

  const offenders: string[] = [];
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(SRC_INDEX_DIR, file));
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
