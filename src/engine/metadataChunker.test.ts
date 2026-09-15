import test from "node:test";
import assert from "node:assert/strict";

import { EngineError } from "./errors";
import { chunkMarkdown } from "./metadataChunker";

void test("chunkMarkdown returns empty for blank input", () => {
  assert.deepEqual(chunkMarkdown("", 1000), []);
  assert.deepEqual(chunkMarkdown("   \n\n   ", 1000), []);
});

void test("chunkMarkdown returns a single chunk for small text", () => {
  const chunks = chunkMarkdown("Hello world.", 1000);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "Hello world.");
  assert.equal(chunks[0].headingBreadcrumb, "");
});

void test("chunkMarkdown packs adjacent small paragraphs into fewer chunks", () => {
  const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
  const chunks = chunkMarkdown(text, 10000);
  assert.equal(chunks.length, 1, "small paragraphs should be packed into one chunk");
  assert.ok(chunks[0].text.includes("First paragraph."));
  assert.ok(chunks[0].text.includes("Second paragraph."));
  assert.ok(chunks[0].text.includes("Third paragraph."));
});

void test("chunkMarkdown splits on headings and builds hierarchical breadcrumbs", () => {
  const text = "# Heading 1\nParagraph one.\n\n## Heading 2\nParagraph two.";
  const chunks = chunkMarkdown(text, 10000);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].headingBreadcrumb, "# Heading 1");
  assert.equal(chunks[1].headingBreadcrumb, "# Heading 1 > ## Heading 2");
});

void test("chunkMarkdown hierarchical breadcrumbs track heading depth correctly", () => {
  const body = "# H1\nA.\n\n## H2\nB.\n\n### H3\nC.\n\n## H2b\nD.\n\n# H1b\nE.";
  const chunks = chunkMarkdown(body, 10000);
  assert.equal(chunks.length, 5);
  assert.equal(chunks[0].headingBreadcrumb, "# H1");
  assert.equal(chunks[1].headingBreadcrumb, "# H1 > ## H2");
  assert.equal(chunks[2].headingBreadcrumb, "# H1 > ## H2 > ### H3");
  assert.equal(chunks[3].headingBreadcrumb, "# H1 > ## H2b");
  assert.equal(chunks[4].headingBreadcrumb, "# H1b");
});

void test("chunkMarkdown handles fenced code blocks as atomic units when within budget", () => {
  const text = "Before.\n\n```python\nfor i in range(10):\n    print(i)\n```\n\nAfter.";
  const chunks = chunkMarkdown(text, 10000);
  assert.equal(chunks.length, 1, "all blocks packed into one chunk when within budget");
  assert.ok(chunks[0].text.includes("```python"));
  assert.ok(chunks[0].text.includes("Before."));
  assert.ok(chunks[0].text.includes("After."));
});

void test("chunkMarkdown heading breadcrumbs with nested headings", () => {
  const text = "# A\nContent A.\n\n## B\nContent B.\n\n## C\nContent C.";
  const chunks = chunkMarkdown(text, 10000);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].headingBreadcrumb, "# A");
  assert.equal(chunks[1].headingBreadcrumb, "# A > ## B");
  assert.equal(chunks[2].headingBreadcrumb, "# A > ## C");
});

void test("chunkMarkdown splits large blocks by sentences then words then hard-split", () => {
  const longParagraph = Array.from({ length: 100 }, (_, i) => `Sentence ${i} with some words.`).join(" ");
  const chunks = chunkMarkdown(longParagraph, 200);
  assert.ok(chunks.length > 1, "should split the long paragraph into multiple chunks");
  const totalText = chunks.map((c) => c.text).join(" ");
  for (let i = 0; i < 100; i++) {
    assert.ok(totalText.includes(`Sentence ${i}`), `missing sentence ${i}`);
  }
});

void test("chunkMarkdown exact content coverage: every non-heading non-blank line appears in chunks", () => {
  const body = [
    "# Main",
    "Line one under main.",
    "Line two under main.",
    "",
    "## Sub A",
    "Content A line 1.",
    "Content A line 2.",
    "",
    "### Deep",
    "Deep content.",
    "",
    "## Sub B",
    "Content B.",
    "",
    "```python",
    "code_line_1()",
    "code_line_2()",
    "```",
    "",
    "Final paragraph.",
  ].join("\n");

  const chunks = chunkMarkdown(body, 10000);
  const contentLines = body.split("\n").filter(l => l.trim() !== "" && !/^#{1,6}\s/.test(l));
  const allChunkText = chunks.map(c => c.text).join("\n");

  for (const line of contentLines) {
    assert.ok(allChunkText.includes(line), `missing content line: "${line}"`);
  }

  const headingLines = body.split("\n").filter(l => /^#{1,6}\s/.test(l));
  for (const heading of headingLines) {
    for (const chunk of chunks) {
      assert.ok(!chunk.text.includes(heading.trim()), `heading should not be in body: "${heading}"`);
    }
  }

  for (const heading of headingLines) {
    assert.ok(
      chunks.some(c => c.headingBreadcrumb.includes(heading.trim())),
      `heading should be in some breadcrumb: "${heading}"`,
    );
  }
});

void test("chunkMarkdown heading text not in chunk body", () => {
  const body = "# Heading\nLine one.\nLine two.\n\n## Sub\nLine three.\nLine four.";
  const chunks = chunkMarkdown(body, 10000);
  const allText = chunks.map((c) => c.text).join("\n");
  assert.ok(allText.includes("Line one."));
  assert.ok(allText.includes("Line four."));
  assert.ok(!allText.includes("# Heading"), "heading text should not be in chunk body");
});

void test("chunkMarkdown handles Unicode text", () => {
  const text = "# 日本語の見出し\nこれはテスト文章です。\n\n## 第二章\nもう一つの段落。";
  const chunks = chunkMarkdown(text, 10000);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].headingBreadcrumb.includes("日本語"));
});

void test("chunkMarkdown handles nested headings with 4 levels", () => {
  const text = "# H1\nA.\n\n## H2\nB.\n\n### H3\nC.\n\n#### H4\nD.";
  const chunks = chunkMarkdown(text, 10000);
  assert.equal(chunks.length, 4);
});

void test("chunkMarkdown handles list blocks", () => {
  const text = "- item 1\n- item 2\n- item 3\n\nParagraph after list.";
  const chunks = chunkMarkdown(text, 10000);
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.some((c) => c.text.includes("item 1")));
});

void test("chunkMarkdown handles tables", () => {
  const text = "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfter table.";
  const chunks = chunkMarkdown(text, 10000);
  assert.ok(chunks.some((c) => c.text.includes("| A | B |")));
});

void test("chunkMarkdown hard-splits a single long word/line", () => {
  const longWord = "a".repeat(500);
  const chunks = chunkMarkdown(longWord, 100);
  assert.ok(chunks.length > 1, "should hard-split a long word");
  const total = chunks.map((c) => c.text).join("");
  assert.equal(total.length, 500);
});

void test("chunkMarkdown rejects oversized input", () => {
  const huge = "x".repeat(3_000_000);
  assert.throws(
    () => chunkMarkdown(huge, 1000),
    (e: unknown) => e instanceof EngineError && e.code === "METADATA_CONFIG_INVALID",
  );
});

void test("chunkMarkdown rejects non-positive maxChunkBytes", () => {
  assert.throws(() => chunkMarkdown("text", 0), (e: unknown) => e instanceof EngineError && e.code === "METADATA_CONFIG_INVALID");
  assert.throws(() => chunkMarkdown("text", -1), (e: unknown) => e instanceof EngineError && e.code === "METADATA_CONFIG_INVALID");
});

void test("chunkMarkdown packing call-count: 20 small paragraphs produce far fewer chunks", () => {
  const paras = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} content.`);
  const body = paras.join("\n\n");
  const chunks = chunkMarkdown(body, 1000);
  assert.ok(chunks.length < 5, `expected fewer than 5 chunks from packing 20 small paragraphs, got ${chunks.length}`);
  for (const para of paras) {
    assert.ok(chunks.some(c => c.text.includes(para)), `missing: ${para}`);
  }
});

void test("chunkMarkdown every chunk body + breadcrumb fits within maxChunkBytes", () => {
  const body = "# Long Heading Name\n" + "word ".repeat(5000) + "\n\n## Another Heading\n" + "text ".repeat(3000);
  const budget = 500;
  const chunks = chunkMarkdown(body, budget);
  for (const c of chunks) {
    const total = Buffer.byteLength(c.text, "utf8") + Buffer.byteLength(c.headingBreadcrumb, "utf8");
    assert.ok(total <= budget, `chunk exceeds budget: ${total} > ${budget}`);
  }
});

void test("chunkMarkdown breadcrumb bytes are budgeted: deeper headings leave less body space", () => {
  const longHeading = "# " + "A".repeat(100);
  const subHeading = "## " + "B".repeat(100);
  const body = `${longHeading}\nContent under H1.\n\n${subHeading}\nContent under H2.`;
  const budget = 300;
  const chunks = chunkMarkdown(body, budget);
  for (const c of chunks) {
    const total = Buffer.byteLength(c.text, "utf8") + Buffer.byteLength(c.headingBreadcrumb, "utf8");
    assert.ok(total <= budget, `chunk exceeds budget: ${total} > ${budget}`);
  }
});

void test("chunkMarkdown fenced block split preserves fence context", () => {
  const codeLines = Array.from({ length: 100 }, (_, i) => `code_line_${i}();`);
  const body = "```javascript\n" + codeLines.join("\n") + "\n```";
  const chunks = chunkMarkdown(body, 500);
  assert.ok(chunks.length > 1, "large fenced block should be split into multiple chunks");
  for (const c of chunks) {
    assert.ok(c.text.startsWith("```javascript"), `each fenced chunk should start with fence header, got: ${c.text.slice(0, 30)}`);
  }
});

void test("chunkMarkdown synthetic 20K input produces non-overlapping chunks within budget", () => {
  const body = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}: ${"word ".repeat(10)}`).join("\n\n");
  assert.ok(body.length > 20_000);
  const chunks = chunkMarkdown(body, 2000);
  assert.ok(chunks.length > 5);
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c.text, "utf8") <= 2000, "chunk exceeds byte budget");
  }
});

void test("chunkMarkdown synthetic 55K input with mixed Markdown", () => {
  const sections = Array.from({ length: 100 }, (_, i) =>
    `## Section ${i}\n${"This is a sentence with some extra words to pad it. ".repeat(20)}\n\n\`\`\`\ncode block ${i} with content\n\`\`\``,
  );
  const body = sections.join("\n\n");
  assert.ok(body.length > 55_000, `expected > 55K, got ${body.length}`);
  const chunks = chunkMarkdown(body, 3000);
  assert.ok(chunks.length > 10);
});

void test("chunkMarkdown synthetic 250K input stays bounded", () => {
  const body = "word ".repeat(50_000);
  assert.ok(body.length >= 250_000);
  const chunks = chunkMarkdown(body, 5000);
  assert.ok(chunks.length > 40);
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c.text, "utf8") <= 5000);
  }
});

void test("chunkMarkdown synthetic 2M input stays bounded and fast with large budget", () => {
  const body = "word ".repeat(400_000);
  assert.ok(body.length >= 2_000_000);
  const start = Date.now();
  const chunks = chunkMarkdown(body, 50_000);
  const elapsed = Date.now() - start;
  assert.ok(chunks.length > 10);
  assert.ok(elapsed < 10_000, `2M input took ${elapsed}ms, expected <10s`);
});

void test("chunkMarkdown oversized atom (single line bigger than budget) is hard-split", () => {
  const bigLine = "x".repeat(1000);
  const body = "# Section\n" + bigLine;
  const chunks = chunkMarkdown(body, 200);
  assert.ok(chunks.length > 1);
  const reconstructed = chunks.map(c => c.text).join("");
  assert.equal(reconstructed.length, 1000, "all bytes preserved after hard split");
  for (const c of chunks) {
    const total = Buffer.byteLength(c.text, "utf8") + Buffer.byteLength(c.headingBreadcrumb, "utf8");
    assert.ok(total <= 200, `chunk exceeds budget: ${total}`);
  }
});
