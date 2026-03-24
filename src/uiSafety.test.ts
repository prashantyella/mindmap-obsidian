import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const bannedPatterns = [
  /\binnerHTML\s*=/,
  /\bouterHTML\s*=/,
  /\binsertAdjacentHTML\s*\(/,
  /\bcreateContextualFragment\s*\(/,
  /\bDOMParser\b/,
  /\bsetHTML\s*\(/,
];

function getRuntimeSourceFiles(rootDir: string): string[] {
  return fs
    .readdirSync(rootDir)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .map((entry) => path.join(rootDir, entry));
}

test("runtime UI source files do not use unsafe HTML insertion APIs", () => {
  const srcDir = path.join(process.cwd(), "src");
  const files = getRuntimeSourceFiles(srcDir);

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of bannedPatterns) {
      assert.equal(
        pattern.test(source),
        false,
        `Unsafe DOM insertion pattern ${pattern} found in ${path.basename(file)}`,
      );
    }
  }
});
