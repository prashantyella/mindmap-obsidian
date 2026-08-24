import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { appleAnnotationConceptWikilinks, appleAnnotationRelatedWikilinks } from "./appleAnnotationWikilinks";

const FIXTURE_PATH = path.resolve(__dirname, "../../tests/fixtures/engine/apple_annotation_wikilinks.json");

interface WikilinkCase {
  name: string;
  input: string[];
  output: string[];
}

function loadCases(): WikilinkCase[] {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as { cases: WikilinkCase[] };
  return raw.cases;
}

void test("appleAnnotationConceptWikilinks matches the python/mindmap.py golden fixture", () => {
  const testCase = loadCases().find((c) => c.name.includes("concept"));
  assert.ok(testCase);
  assert.deepEqual(appleAnnotationConceptWikilinks(testCase!.input), testCase!.output);
});

void test("appleAnnotationRelatedWikilinks matches the python/mindmap.py golden fixture", () => {
  const testCase = loadCases().find((c) => c.name.includes("related"));
  assert.ok(testCase);
  assert.deepEqual(appleAnnotationRelatedWikilinks(testCase!.input), testCase!.output);
});

void test("appleAnnotationRelatedWikilinks accepts a legitimate dot-prefixed user folder like .journal", () => {
  const result = appleAnnotationRelatedWikilinks([".journal/Note.md"]);
  assert.deepEqual(result, ["[[.journal/Note|Note]]"]);
});

void test("appleAnnotationRelatedWikilinks still rejects traversal, absolute paths, and non-Markdown targets", () => {
  const result = appleAnnotationRelatedWikilinks(["../Escape.md", "/etc/passwd.md", "Notes/file.txt", "Notes/[bad].md", "Notes/pipe|bad.md"]);
  assert.deepEqual(result, []);
});
