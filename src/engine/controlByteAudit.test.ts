import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * A regex literal that embeds a real control byte in the source is
 * indistinguishable, at the source-byte level, from a stray control byte
 * that leaked in by accident -- both bugs bit this codebase once already.
 * This audit fails closed on any C0 control byte or DEL in any
 * src/engine/*.ts file (tests included), allowing only tab, LF, and CR
 * (the three control bytes a normal source file legitimately contains).
 */
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d]);

void test("no src/engine/*.ts file contains a literal control byte (only tab/LF/CR are allowed)", () => {
  const engineDir = __dirname;
  const offenders: string[] = [];
  for (const fileName of fs.readdirSync(engineDir)) {
    if (!fileName.endsWith(".ts")) continue;
    const fullPath = path.join(engineDir, fileName);
    const data = fs.readFileSync(fullPath);
    for (let index = 0; index < data.length; index += 1) {
      const byte = data[index];
      const isC0Control = byte <= 0x1f;
      const isDelete = byte === 0x7f;
      if ((isC0Control || isDelete) && !ALLOWED_CONTROL_BYTES.has(byte)) {
        offenders.push(`${fileName}@byte${index} (0x${byte.toString(16).padStart(2, "0")})`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Found literal control bytes: ${offenders.join(", ")}`);
});
