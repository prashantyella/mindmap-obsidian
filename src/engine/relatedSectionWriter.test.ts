import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { canonicalizePath } from "./contracts";
import { clearManagedRelatedSection, updateRelatedSection } from "./relatedSectionWriter";

const FIXTURE_PATH = path.resolve(__dirname, "../../tests/fixtures/engine/related_section.json");

interface RelatedSectionCase {
  name: string;
  input: string;
  heading: string;
  output: string;
  links?: [string, string][];
}

function loadCases(): RelatedSectionCase[] {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as { cases: RelatedSectionCase[] };
  return raw.cases;
}

void test("updateRelatedSection renders a fresh callout block matching the python/mindmap.py golden fixture", () => {
  const testCase = loadCases().find((c) => c.name === "update_related_section renders a fresh callout block");
  assert.ok(testCase);
  const links = testCase!.links!.map(([p, kind]) => ({ path: canonicalizePath(p), kind: kind as "core" | "overreach" | "creative" | "fill" }));
  const output = updateRelatedSection(testCase!.input, links, { heading: testCase!.heading, newline: "\n" });
  assert.equal(output, testCase!.output);
});

void test("updateRelatedSection with no links removes any existing managed section and appends nothing", () => {
  const body = "Body content.\n\n---\n\n> [!mindmap]- Mindmap\n> - <span class=\"mindmap-link is-core\">[[Notes/A|A]]</span>\n";
  const output = updateRelatedSection(body, [], { newline: "\n" });
  assert.equal(output, "Body content.\n");
});

void test("updateRelatedSection preserves CRLF convention on an untouched prefix and in its own regenerated block", () => {
  const body = "First line.\r\nSecond line.\r\n";
  const output = updateRelatedSection(body, [{ path: canonicalizePath("Notes/A.md"), kind: "core" }], { newline: "\r\n" });
  assert.equal(
    output,
    'First line.\r\nSecond line.\r\n\r\n---\r\n\r\n> [!mindmap]- Mindmap\r\n> - <span class="mindmap-link is-core">[[Notes/A.md|A]]</span>\r\n',
  );
});

void test("clearManagedRelatedSection removes a callout block and adds nothing back", () => {
  const body = "Quote body.\n\n---\n\n> [!mindmap]- Mindmap\n> - <span class=\"mindmap-link is-core\">[[Notes/A|A]]</span>\n";
  assert.equal(clearManagedRelatedSection(body), "Quote body.\n");
});

void test("clearManagedRelatedSection is a byte-exact no-op when nothing managed is present", () => {
  const body = "Quote body.\nSecond line.\n";
  assert.equal(clearManagedRelatedSection(body), body);
});

void test("updateRelatedSection silently skips a candidate whose path contains < or > instead of injecting markup", () => {
  const maliciousPath = canonicalizePath('Notes/<img src=x onerror=alert(1)>.md');
  const output = updateRelatedSection("Body.\n", [{ path: maliciousPath, kind: "core" }], { newline: "\n" });
  assert.doesNotMatch(output, /<img/);
  assert.equal(output, "Body.\n", "with the only candidate rejected, no callout should be rendered at all");
});

void test("updateRelatedSection emits & ' \" in a path/label verbatim, matching python/mindmap.py (no HTML escaping)", () => {
  const ordinaryPath = canonicalizePath("Notes/Design & Ops's \"Review\".md");
  const output = updateRelatedSection("Body.\n", [{ path: ordinaryPath, kind: "core" }], { newline: "\n" });
  assert.match(output, /\[\[Notes\/Design & Ops's "Review"\.md\|Design & Ops's "Review"\]\]/);
});

void test("updateRelatedSection silently skips a candidate whose path contains a wikilink delimiter instead of emitting broken syntax", () => {
  const unsafe = "Notes/[bad|inject].md" as unknown as ReturnType<typeof canonicalizePath>;
  const output = updateRelatedSection("Body.\n", [{ path: unsafe, kind: "core" }], { newline: "\n" });
  assert.doesNotMatch(output, /\[bad\|inject\]/);
  assert.equal(output, "Body.\n", "with the only candidate rejected, no callout should be rendered at all");
});
