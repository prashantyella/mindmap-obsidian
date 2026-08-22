#!/usr/bin/env -S npx tsx
/**
 * Development-only parity comparison command for the TypeScript engine
 * rewrite. Reads a fixture JSON file from tests/fixtures/engine/ and
 * re-emits it as normalized (canonically key-ordered-as-authored,
 * two-space-indented, newline-terminated) JSON to stdout, so a human or a
 * future TS implementation's own JSON output can be diffed against the
 * Python-derived fixture byte-for-byte.
 *
 * This file lives under tools/parity/, which is intentionally outside
 * tsconfig.json's `include` and outside esbuild's entry graph (see
 * ../../src/engine/parityToolIsolation.test.ts, which asserts nothing under
 * src/ imports tools/parity/). It is never built into dist/main.js and is
 * never invoked by production code. It reads only local fixture files: no
 * vault access, no network access.
 *
 * Usage: npx tsx tools/parity/compare.mts tests/fixtures/engine/chunking.json
 */
import fs from "node:fs";
import path from "node:path";

function normalize(fixturePath: string): string {
  const raw = fs.readFileSync(fixturePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function main(): void {
  const [, , fixtureArg] = process.argv;
  if (!fixtureArg) {
    process.stderr.write("Usage: npx tsx tools/parity/compare.mts <fixture-file>\n");
    process.exitCode = 1;
    return;
  }
  const fixturePath = path.resolve(fixtureArg);
  process.stdout.write(normalize(fixturePath));
}

main();
