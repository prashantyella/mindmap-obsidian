import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { isEngineError } from "./errors";
import { parseFrontmatter, updateFrontmatter } from "./frontmatterEngine";

const FIXTURE_PATH = path.resolve(__dirname, "../../tests/fixtures/engine/frontmatter.json");

interface FrontmatterCase {
  name: string;
  input: string;
  updates?: Record<string, unknown>;
  preferred_order?: string[];
  remove_keys?: string[];
  output?: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
}

function loadCases(): FrontmatterCase[] {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as { cases: FrontmatterCase[] };
  return raw.cases;
}

void test("updateFrontmatter matches every ported python/mindmap.py update_frontmatter golden fixture byte-for-byte", () => {
  for (const testCase of loadCases()) {
    if (testCase.updates === undefined) continue;
    const output = updateFrontmatter(testCase.input, {
      updates: testCase.updates,
      preferredOrder: testCase.preferred_order ?? [],
      removeKeys: testCase.remove_keys,
    });
    assert.equal(output, testCase.output, testCase.name);
  }
});

void test("parseFrontmatter matches the python/mindmap.py parse_frontmatter golden fixture", () => {
  const testCase = loadCases().find((c) => c.frontmatter !== undefined);
  assert.ok(testCase);
  const { frontmatter, body } = parseFrontmatter(testCase!.input);
  assert.deepEqual(frontmatter, testCase!.frontmatter);
  assert.equal(body, testCase!.body);
});

void test("updateFrontmatter preserves CRLF convention in both the regenerated frontmatter and the body", () => {
  const input = "---\r\ntitle: Example\r\nsummary: old\r\n---\r\nBody.\r\nSecond line.\r\n";
  const output = updateFrontmatter(input, { updates: { summary: "new" }, preferredOrder: ["summary"] });
  assert.equal(output, "---\r\ntitle: Example\r\nsummary: new\r\n---\r\nBody.\r\nSecond line.\r\n");
  assert.ok(!output.includes("\r\n\n"), "must not mix a bare LF alongside CRLF lines");
});

void test("updateFrontmatter appends a brand-new managed key in CRLF style on a CRLF note", () => {
  const input = "---\r\ntitle: Example\r\n---\r\nBody.\r\n";
  const output = updateFrontmatter(input, { updates: { related: ["Notes/Other.md"] }, preferredOrder: ["related"] });
  assert.equal(output, "---\r\ntitle: Example\r\nrelated:\r\n  - Notes/Other.md\r\n---\r\nBody.\r\n");
});

void test("updateFrontmatter creates a fresh frontmatter block when none exists", () => {
  const input = "Just a body, no frontmatter.\n";
  const output = updateFrontmatter(input, { updates: { summary: "s" }, preferredOrder: ["summary"] });
  assert.equal(output, "---\nsummary: s\n---\nJust a body, no frontmatter.\n");
});

void test("updateFrontmatter fails closed (throws, no partial output observable) on malformed YAML", () => {
  const input = "---\ntitle: [unterminated\nsummary: old\n---\nBody.\n";
  assert.throws(
    () => updateFrontmatter(input, { updates: { summary: "new" }, preferredOrder: ["summary"] }),
    (error: unknown) => isEngineError(error) && error.code === "FRONTMATTER_MALFORMED",
  );
});

void test("updateFrontmatter fails closed on duplicate top-level keys", () => {
  const input = "---\ntitle: A\ntitle: B\nsummary: old\n---\nBody.\n";
  assert.throws(
    () => updateFrontmatter(input, { updates: { summary: "new" }, preferredOrder: ["summary"] }),
    (error: unknown) => isEngineError(error) && error.code === "FRONTMATTER_MALFORMED",
  );
});

void test("updateFrontmatter fails closed when frontmatter root is not a YAML mapping", () => {
  const input = "---\n- a\n- b\n---\nBody.\n";
  assert.throws(
    () => updateFrontmatter(input, { updates: { summary: "new" }, preferredOrder: ["summary"] }),
    (error: unknown) => isEngineError(error) && error.code === "FRONTMATTER_MALFORMED",
  );
});

void test("updateFrontmatter is idempotent across ten repeated applications of the same updates", () => {
  let text = "---\ntitle: Example\nauthor: Jane\n---\nBody.\n";
  const options = {
    updates: { summary: "s", tags: ["a", "b"], concepts: ["c"], related: ["Notes/Other.md"] },
    preferredOrder: ["summary", "tags", "concepts", "related"],
  };
  text = updateFrontmatter(text, options);
  const afterFirst = text;
  for (let i = 0; i < 9; i += 1) {
    text = updateFrontmatter(text, options);
  }
  assert.equal(text, afterFirst);
});

void test("updateFrontmatter keeps a trailing same-line comment on an updated key", () => {
  const input = "---\ntitle: Example\nsummary: old  # keep this note\n---\nBody.\n";
  const output = updateFrontmatter(input, { updates: { summary: "new summary" }, preferredOrder: ["summary"] });
  assert.equal(output, "---\ntitle: Example\nsummary: new summary  # keep this note\n---\nBody.\n");
});

void test("updateFrontmatter keeps a trailing same-line comment on an updated list-valued key", () => {
  const input = "---\ntags: [alpha]  # curated\n---\nBody.\n";
  const output = updateFrontmatter(input, { updates: { tags: ["beta", "gamma"] }, preferredOrder: ["tags"] });
  assert.equal(output, "---\ntags:\n  - beta\n  - gamma  # curated\n---\nBody.\n");
});

void test("updateFrontmatter leaves a removed key's trailing comment behind as a standalone comment line", () => {
  const input = "---\ntitle: Annotation\nsummary: old  # do not lose this\ntags:\n  - alpha\n---\nQuote.\n";
  const output = updateFrontmatter(input, {
    updates: { concepts: ["[[One]]"] },
    preferredOrder: ["concepts"],
    removeKeys: ["summary", "tags"],
  });
  assert.equal(output, "---\ntitle: Annotation\n  # do not lose this\nconcepts:\n  - '[[One]]'\n---\nQuote.\n");
  // The preserved standalone comment (now indented, on its own line where "summary:" used to
  // be) must still parse as valid YAML -- it is a legal indented full-line comment, not a
  // dangling/malformed fragment -- and the surviving keys must read back correctly.
  const parsed = parseFrontmatter(output);
  assert.deepEqual(parsed.frontmatter, { title: "Annotation", concepts: ["[[One]]"] });
  assert.equal(parsed.body, "Quote.\n");
});

void test("updateFrontmatter drops a removed key with no comment exactly as before (no stray blank line)", () => {
  const input = "---\ntitle: Annotation\nsummary: old\ntags:\n  - alpha\n---\nQuote.\n";
  const output = updateFrontmatter(input, { updates: {}, preferredOrder: [], removeKeys: ["summary", "tags"] });
  assert.equal(output, "---\ntitle: Annotation\n---\nQuote.\n");
});

void test("updateFrontmatter preserves a comment that trails a block-scalar/multiline managed value's own next key untouched", () => {
  // The comment sits between the block-scalar key and the next key -- it belongs to neither
  // range (it is a leading/standalone comment before "tags"), so it survives even though
  // "summary" itself is being replaced.
  const input = "---\nsummary: |\n  first\n  second\n# a standalone comment\ntags:\n  - alpha\n---\nBody.\n";
  const output = updateFrontmatter(input, { updates: { summary: "one line now" }, preferredOrder: ["summary"] });
  assert.equal(output, "---\nsummary: one line now\n# a standalone comment\ntags:\n  - alpha\n---\nBody.\n");
});
