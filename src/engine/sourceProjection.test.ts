import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, stableNoteIdentity } from "./contracts";
import { MANAGED_SECTION_RELATED, projectSource } from "./sourceProjection";
import { READING_SOURCE_END, READING_SOURCE_START } from "../readingTypes";

function identityFor(path: string) {
  return stableNoteIdentity(canonicalizePath(path));
}

void test("projectSource excludes managed frontmatter keys but keeps unrelated fields and their order", () => {
  const raw = [
    "---",
    "title: Example",
    "summary: Generated summary.",
    "tags:",
    "  - alpha",
    "  - beta",
    "author: Jane",
    "concepts:",
    "  - one",
    "related:",
    "  - Notes/Other.md",
    "---",
    "Body content.",
    "",
  ].join("\n");
  const projection = projectSource(identityFor("Notes/Example.md"), raw);
  assert.deepEqual(projection.excludedFrontmatterKeys.sort(), ["concepts", "related", "summary", "tags"].sort());
  assert.match(projection.projectedFrontmatterJson, /title/);
  assert.match(projection.projectedFrontmatterJson, /author/);
  assert.doesNotMatch(projection.projectedFrontmatterJson, /Generated summary/);
  assert.doesNotMatch(projection.projectedFrontmatterJson, /alpha/);
});

void test("projectSource hash is stable when only Mindmap-managed frontmatter/output changes", () => {
  const before = [
    "---",
    "title: Example",
    "summary: First generated summary.",
    "tags:",
    "  - alpha",
    "---",
    "Body content.",
    "",
  ].join("\n");
  const after = [
    "---",
    "title: Example",
    "summary: A completely different generated summary.",
    "tags:",
    "  - beta",
    "  - gamma",
    "---",
    "Body content.",
    "",
  ].join("\n");
  const identity = identityFor("Notes/Example.md");
  assert.equal(projectSource(identity, before).sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource hash is stable when only the managed Mindmap/Related section changes", () => {
  const identity = identityFor("Notes/Example.md");
  const before = "Body content.\n\n---\n\n> [!mindmap]- Mindmap\n> - <span class=\"mindmap-link is-core\">[[Notes/A|A]]</span>\n";
  const after = "Body content.\n\n---\n\n> [!mindmap]- Mindmap\n> - <span class=\"mindmap-link is-core\">[[Notes/B|B]]</span>\n> - <span class=\"mindmap-link is-overreach\">[[Notes/C|C]]</span>\n";
  assert.equal(projectSource(identity, before).sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource records that the related section was excluded when present", () => {
  const identity = identityFor("Notes/Example.md");
  const withSection = "Body content.\n\n---\n\n> [!mindmap]- Mindmap\n> - <span class=\"mindmap-link is-core\">[[Notes/A|A]]</span>\n";
  const withoutSection = "Body content.\n";
  assert.deepEqual(projectSource(identity, withSection).excludedManagedSections, [MANAGED_SECTION_RELATED]);
  assert.deepEqual(projectSource(identity, withoutSection).excludedManagedSections, []);
});

void test("projectSource hash changes when user-authored body content changes", () => {
  const identity = identityFor("Notes/Example.md");
  const before = "---\ntitle: Example\n---\nOriginal user text.\n";
  const after = "---\ntitle: Example\n---\nEdited user text.\n";
  assert.notEqual(projectSource(identity, before).sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource hash changes when a non-managed frontmatter field changes", () => {
  const identity = identityFor("Notes/Example.md");
  const before = "---\ntitle: Example\nauthor: Jane\n---\nBody.\n";
  const after = "---\ntitle: Example\nauthor: John\n---\nBody.\n";
  assert.notEqual(projectSource(identity, before).sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource produces the same hash for LF and CRLF versions of identical content", () => {
  const identity = identityFor("Notes/Example.md");
  const lf = "---\ntitle: Example\nsummary: Generated.\n---\nLine one.\nLine two.\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  const lfProjection = projectSource(identity, lf);
  const crlfProjection = projectSource(identity, crlf);
  assert.equal(lfProjection.sourceHash, crlfProjection.sourceHash);
});

void test("projectSource preserves original CRLF bytes in the projected body rather than normalizing them", () => {
  const identity = identityFor("Notes/Example.md");
  const crlf = "---\r\ntitle: Example\r\n---\r\nLine one.\r\nLine two.\r\n";
  const projection = projectSource(identity, crlf);
  assert.match(projection.projectedBody, /\r\n/);
  assert.doesNotMatch(projection.projectedBody.replace(/\r\n/g, ""), /\r|\n/);
});

void test("projectSource never excludes the Reading annotation source block: it is processing input, not managed output", () => {
  const identity = identityFor("Books/Apple Books/Author/Book/Annotations/1.md");
  const raw = [
    "---",
    "type: apple-books-annotation",
    "---",
    READING_SOURCE_START,
    "> Some quote from Apple Books.",
    READING_SOURCE_END,
    "",
    "User research notes go here.",
    "",
  ].join("\n");
  const projection = projectSource(identity, raw);
  assert.deepEqual(projection.excludedManagedSections, []);
  assert.match(projection.projectedBody, /Some quote from Apple Books/);
  assert.match(projection.projectedBody, /User research notes go here/);
});

void test("projectSource hash changes when the Apple Books quote changes inside legacy mindmap:apple-books-source markers", () => {
  const identity = identityFor("Books/Apple Books/Author/Book/Annotations/1.md");
  const before = [
    READING_SOURCE_START,
    "> Original quote.",
    READING_SOURCE_END,
    "",
    "User research notes.",
    "",
  ].join("\n");
  const after = [
    READING_SOURCE_START,
    "> A different quote entirely.",
    READING_SOURCE_END,
    "",
    "User research notes.",
    "",
  ].join("\n");
  assert.notEqual(projectSource(identity, before).sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource hash changes when the Apple Books quote changes in the current markerless leading-blockquote format", () => {
  const identity = identityFor("Books/Apple Books/Author/Book/Annotations/1.md");
  const before = [
    "> Original quote from the book.",
    "",
    "User research notes.",
    "",
  ].join("\n");
  const after = [
    "> A materially different quote from the book.",
    "",
    "User research notes.",
    "",
  ].join("\n");
  assert.notEqual(projectSource(identity, before).sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource produces deterministic, repeatable output for identical input", () => {
  const identity = identityFor("Notes/Example.md");
  const raw = "---\ntitle: Example\nsummary: Generated.\n---\nBody.\n";
  const first = projectSource(identity, raw);
  const second = projectSource(identity, raw);
  assert.deepEqual(first, second);
});

void test("projectSource handles notes with no frontmatter at all", () => {
  const identity = identityFor("Notes/Example.md");
  const projection = projectSource(identity, "Just a body, no frontmatter.\n");
  assert.deepEqual(projection.excludedFrontmatterKeys, []);
  assert.match(projection.projectedBody, /Just a body/);
});

void test("projectSource preserves a column-0 comment immediately following a removed managed key, and its text changes the hash", () => {
  const before = [
    "---",
    "title: Example",
    "summary: Generated summary.",
    "# a note to self about this file",
    "author: Jane",
    "---",
    "Body.",
    "",
  ].join("\n");
  const after = [
    "---",
    "title: Example",
    "summary: A totally different generated summary.",
    "# a note to self about this file",
    "author: Jane",
    "---",
    "Body.",
    "",
  ].join("\n");
  const identity = identityFor("Notes/Example.md");
  const beforeProjection = projectSource(identity, before);
  assert.match(beforeProjection.projectedFrontmatterJson, /a note to self about this file/);
  assert.doesNotMatch(beforeProjection.projectedFrontmatterJson, /Generated summary/);
  assert.equal(beforeProjection.sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource hash changes when only the text of a preserved comment changes", () => {
  const identity = identityFor("Notes/Example.md");
  const before = [
    "---",
    "title: Example",
    "summary: Generated summary.",
    "# original comment",
    "author: Jane",
    "---",
    "Body.",
    "",
  ].join("\n");
  const after = [
    "---",
    "title: Example",
    "summary: Generated summary.",
    "# edited comment",
    "author: Jane",
    "---",
    "Body.",
    "",
  ].join("\n");
  assert.notEqual(projectSource(identity, before).sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource preserves a blank line adjacent to a removed managed key rather than swallowing it", () => {
  const raw = [
    "---",
    "title: Example",
    "tags:",
    "  - alpha",
    "",
    "author: Jane",
    "---",
    "Body.",
    "",
  ].join("\n");
  const identity = identityFor("Notes/Example.md");
  const projection = projectSource(identity, raw);
  assert.deepEqual(projection.excludedFrontmatterKeys, ["tags"]);
  const decoded = JSON.parse(projection.projectedFrontmatterJson) as string;
  assert.match(decoded, /title: Example\n\nauthor: Jane\n/);
});

// --- Related-section owned-region hash equivalence (pre-write vs post-write) ---

void test("projectSource: a body with no Mindmap section hashes identically to that same body after Mindmap writes its current callout output", () => {
  const identity = identityFor("Notes/Example.md");
  const before = "Body content.\n";
  // Exactly what update_related_section produces from `before`: strip_trailing_dividers(before) + "\n\n---\n\n" + calloutBlock + "\n".
  const after = "Body content.\n\n---\n\n> [!mindmap]- Mindmap\n> - <span class=\"mindmap-link is-core\">[[Notes/A|A]]</span>\n";
  const beforeProjection = projectSource(identity, before);
  const afterProjection = projectSource(identity, after);
  assert.equal(beforeProjection.sourceHash, afterProjection.sourceHash);
  assert.equal(afterProjection.projectedBody, before);
});

void test("projectSource: re-hashing after Mindmap changes an existing callout's links stays stable", () => {
  const identity = identityFor("Notes/Example.md");
  const firstWrite = "Body content.\n\n---\n\n> [!mindmap]- Mindmap\n> - <span class=\"mindmap-link is-core\">[[Notes/A|A]]</span>\n";
  const secondWrite = "Body content.\n\n---\n\n> [!mindmap]- Mindmap\n> - <span class=\"mindmap-link is-core\">[[Notes/B|B]]</span>\n> - <span class=\"mindmap-link is-overreach\">[[Notes/C|C]]</span>\n";
  assert.equal(projectSource(identity, firstWrite).sourceHash, projectSource(identity, secondWrite).sourceHash);
});

void test("projectSource strips every managed callout when a legacy write left two, not just the first", () => {
  const identity = identityFor("Notes/Example.md");
  const before = "Body content.\n";
  const doubled =
    "Body content.\n\n---\n\n> [!mindmap]- Mindmap\n> - <span class=\"mindmap-link is-core\">[[Notes/A|A]]</span>\n\n---\n\n> [!mindmap]- Related\n> - <span class=\"mindmap-link is-core\">[[Notes/B|B]]</span>\n";
  const beforeProjection = projectSource(identity, before);
  const doubledProjection = projectSource(identity, doubled);
  assert.equal(doubledProjection.projectedBody, before);
  assert.equal(beforeProjection.sourceHash, doubledProjection.sourceHash);
});

void test("projectSource: a divider unrelated to the callout (not immediately preceding it) is left in place, not consumed", () => {
  const identity = identityFor("Notes/Example.md");
  const raw = "User section one.\n\n---\n\nUser section two.\n\n---\n\n> [!mindmap]- Mindmap\n> - <span class=\"mindmap-link is-core\">[[Notes/A|A]]</span>\n";
  const projection = projectSource(identity, raw);
  assert.equal(projection.projectedBody, "User section one.\n\n---\n\nUser section two.\n");
});

// --- Legacy mindmap:start/mindmap:end marker-pair removal ---

void test("projectSource removes a complete well-formed legacy marker region, including its wrapped content", () => {
  const identity = identityFor("Notes/Example.md");
  const raw = "User text before.\n<!-- mindmap:start -->\nOld generated block content.\nMore old content.\n<!-- mindmap:end -->\nUser text after.\n";
  const projection = projectSource(identity, raw);
  assert.doesNotMatch(projection.projectedBody, /Old generated block content/);
  assert.doesNotMatch(projection.projectedBody, /mindmap:start/);
  assert.doesNotMatch(projection.projectedBody, /mindmap:end/);
  assert.match(projection.projectedBody, /User text before/);
  assert.match(projection.projectedBody, /User text after/);
  assert.deepEqual(projection.excludedManagedSections, [MANAGED_SECTION_RELATED]);
});

void test("projectSource hash is stable when only the content wrapped by a complete legacy marker region changes", () => {
  const identity = identityFor("Notes/Example.md");
  const before = "User text.\n<!-- mindmap:start -->\nOld content.\n<!-- mindmap:end -->\n";
  const after = "User text.\n<!-- mindmap:start -->\nCompletely different regenerated content.\nWith more lines.\n<!-- mindmap:end -->\n";
  assert.equal(projectSource(identity, before).sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource leaves an orphan legacy start marker (no matching end) untouched and hash-relevant", () => {
  const identity = identityFor("Notes/Example.md");
  const before = "User text.\n<!-- mindmap:start -->\nSome content that never got closed.\n";
  const after = "User text.\n<!-- mindmap:start -->\nDifferent content that never got closed.\n";
  const beforeProjection = projectSource(identity, before);
  assert.match(beforeProjection.projectedBody, /mindmap:start/);
  assert.match(beforeProjection.projectedBody, /never got closed/);
  assert.deepEqual(beforeProjection.excludedManagedSections, []);
  assert.notEqual(beforeProjection.sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource leaves an orphan legacy end marker (no matching start) untouched and hash-relevant", () => {
  const identity = identityFor("Notes/Example.md");
  const before = "User text.\nSome trailing content.\n<!-- mindmap:end -->\n";
  const after = "User text.\nDifferent trailing content.\n<!-- mindmap:end -->\n";
  const beforeProjection = projectSource(identity, before);
  assert.match(beforeProjection.projectedBody, /mindmap:end/);
  assert.deepEqual(beforeProjection.excludedManagedSections, []);
  assert.notEqual(beforeProjection.sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource leaves a reversed legacy marker pair (end before start) untouched and hash-relevant", () => {
  const identity = identityFor("Notes/Example.md");
  const before = "<!-- mindmap:end -->\nContent in between.\n<!-- mindmap:start -->\n";
  const after = "<!-- mindmap:end -->\nDifferent content in between.\n<!-- mindmap:start -->\n";
  const beforeProjection = projectSource(identity, before);
  assert.deepEqual(beforeProjection.excludedManagedSections, []);
  assert.match(beforeProjection.projectedBody, /Content in between/);
  assert.notEqual(beforeProjection.sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource leaves duplicated legacy start markers untouched and hash-relevant", () => {
  const identity = identityFor("Notes/Example.md");
  const before = "<!-- mindmap:start -->\nFirst.\n<!-- mindmap:start -->\nSecond.\n<!-- mindmap:end -->\n";
  const after = "<!-- mindmap:start -->\nFirst edited.\n<!-- mindmap:start -->\nSecond.\n<!-- mindmap:end -->\n";
  const beforeProjection = projectSource(identity, before);
  assert.deepEqual(beforeProjection.excludedManagedSections, []);
  assert.notEqual(beforeProjection.sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource treats ordinary user prose that merely contains the words mindmap:start/mindmap:end as regular hash-relevant content", () => {
  const identity = identityFor("Notes/Example.md");
  const before = "I was reading about how mindmap:start and mindmap:end markers used to work in the old plugin version.\n";
  const after = "I was reading about how mindmap:start and mindmap:end markers work differently now.\n";
  const beforeProjection = projectSource(identity, before);
  assert.deepEqual(beforeProjection.excludedManagedSections, []);
  assert.match(beforeProjection.projectedBody, /mindmap:start/);
  assert.notEqual(beforeProjection.sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource does not treat two separate ordinary prose lines, one mentioning mindmap:start and another mindmap:end, as a marker pair", () => {
  const identity = identityFor("Notes/Example.md");
  // Neither line is the exact `<!-- mindmap:start -->` / `<!-- mindmap:end -->` comment shape,
  // so a naive substring-per-line scan (matching exactly one "start" line and one "end" line, in
  // order) would wrongly treat this ordinary two-sentence paragraph as a well-formed marker pair
  // and delete both lines plus everything between them.
  const before = [
    "Some notes on the mindmap:start of the meeting.",
    "A completely unrelated middle line that must survive.",
    "And thoughts on the mindmap:end of the discussion.",
    "",
  ].join("\n");
  const after = [
    "Some notes on the mindmap:start of the meeting, revised.",
    "A completely unrelated middle line that must survive.",
    "And thoughts on the mindmap:end of the discussion.",
    "",
  ].join("\n");
  const beforeProjection = projectSource(identity, before);
  assert.deepEqual(beforeProjection.excludedManagedSections, []);
  assert.equal(beforeProjection.projectedBody, before);
  assert.match(beforeProjection.projectedBody, /mindmap:start/);
  assert.match(beforeProjection.projectedBody, /completely unrelated middle line/);
  assert.match(beforeProjection.projectedBody, /mindmap:end/);
  assert.notEqual(beforeProjection.sourceHash, projectSource(identity, after).sourceHash);
});

// --- Multiline managed frontmatter values (block scalars/sequences with internal blank lines) ---

void test("projectSource excludes a multiline block-scalar summary (with an internal blank line) without leaking its continuation lines", () => {
  const raw = [
    "---",
    "title: Example",
    "summary: |",
    "  Paragraph one of the generated summary.",
    "",
    "  Paragraph two of the generated summary.",
    "tags:",
    "  - alpha",
    "author: Jane",
    "---",
    "Body.",
    "",
  ].join("\n");
  const identity = identityFor("Notes/Example.md");
  const projection = projectSource(identity, raw);
  assert.deepEqual(projection.excludedFrontmatterKeys.sort(), ["summary", "tags"]);
  assert.doesNotMatch(projection.projectedFrontmatterJson, /Paragraph one/);
  assert.doesNotMatch(projection.projectedFrontmatterJson, /Paragraph two/);
  assert.match(projection.projectedFrontmatterJson, /title: Example/);
  assert.match(projection.projectedFrontmatterJson, /author: Jane/);
});

void test("projectSource hash is stable when a multiline block-scalar summary is regenerated with different paragraph text/line count", () => {
  const identity = identityFor("Notes/Example.md");
  const before = [
    "---",
    "title: Example",
    "summary: |",
    "  First version, paragraph one.",
    "",
    "  First version, paragraph two.",
    "---",
    "Body.",
    "",
  ].join("\n");
  const after = [
    "---",
    "title: Example",
    "summary: |",
    "  A completely rewritten single-paragraph summary with different wording.",
    "---",
    "Body.",
    "",
  ].join("\n");
  assert.equal(projectSource(identity, before).sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource preserves a column-0 comment immediately after a multiline managed block, without absorbing it into the excluded block", () => {
  const raw = [
    "---",
    "title: Example",
    "summary: |",
    "  Paragraph one.",
    "",
    "  Paragraph two.",
    "# a genuine user comment right after the managed summary",
    "author: Jane",
    "---",
    "Body.",
    "",
  ].join("\n");
  const identity = identityFor("Notes/Example.md");
  const projection = projectSource(identity, raw);
  assert.deepEqual(projection.excludedFrontmatterKeys, ["summary"]);
  assert.match(projection.projectedFrontmatterJson, /a genuine user comment right after the managed summary/);
  assert.doesNotMatch(projection.projectedFrontmatterJson, /Paragraph one/);
});

void test("projectSource hash changes when the text of a comment adjacent to a multiline managed block changes", () => {
  const identity = identityFor("Notes/Example.md");
  const before = [
    "---",
    "title: Example",
    "summary: |",
    "  Paragraph one.",
    "",
    "  Paragraph two.",
    "# original comment",
    "---",
    "Body.",
    "",
  ].join("\n");
  const after = [
    "---",
    "title: Example",
    "summary: |",
    "  Paragraph one.",
    "",
    "  Paragraph two.",
    "# edited comment",
    "---",
    "Body.",
    "",
  ].join("\n");
  assert.notEqual(projectSource(identity, before).sourceHash, projectSource(identity, after).sourceHash);
});

void test("projectSource keeps a managed key's trailing same-line comment hash-relevant even though the key itself is excluded", () => {
  const identity = identityFor("Notes/Example.md");
  const before = ["---", "title: Example", "summary: old  # a genuine user note", "---", "Body.", ""].join("\n");
  const after = ["---", "title: Example", "summary: old  # an edited user note", "---", "Body.", ""].join("\n");
  const projectionBefore = projectSource(identity, before);
  const projectionAfter = projectSource(identity, after);
  assert.deepEqual(projectionBefore.excludedFrontmatterKeys, ["summary"]);
  assert.match(projectionBefore.projectedFrontmatterJson, /a genuine user note/);
  assert.doesNotMatch(projectionBefore.projectedFrontmatterJson, /^old$/m);
  assert.notEqual(
    projectionBefore.sourceHash,
    projectionAfter.sourceHash,
    "editing only the comment text on a managed key must change sourceHash",
  );
});

void test("projectSource hash is stable across a managed key's own value changing when its trailing comment does not", () => {
  const identity = identityFor("Notes/Example.md");
  const before = ["---", "title: Example", "summary: old  # unrelated note", "---", "Body.", ""].join("\n");
  const afterManagedRewrite = ["---", "title: Example", "summary: brand new generated summary  # unrelated note", "---", "Body.", ""].join("\n");
  assert.equal(
    projectSource(identity, before).sourceHash,
    projectSource(identity, afterManagedRewrite).sourceHash,
    "Mindmap regenerating only the managed summary value (comment untouched) must not change sourceHash",
  );
});
