import test from "node:test";
import assert from "node:assert/strict";

import {
  isValidAnnotationSourcePath,
  companionPathForAnnotation,
  renderCompanionNote,
  writeCompanionNote,
  extractLegacyInlineResearch,
} from "./readingResearchCompanion";
import { renderCompanionResearchContent, RESEARCH_END, RESEARCH_START } from "./researchWriter";
import type { ReadingVault, VaultEntry } from "./readingVault";

class MockVault implements ReadingVault {
  files = new Map<string, string>();
  folders = new Set<string>();
  unreadable = new Set<string>();
  get(path: string): VaultEntry | null {
    if (this.files.has(path) || this.unreadable.has(path)) return { path, raw: path };
    return this.folders.has(path) ? { path, raw: path } : null;
  }
  async read(entry: VaultEntry): Promise<string> {
    if (this.unreadable.has(entry.path)) throw new Error(`Unreadable: ${entry.path}`);
    const text = this.files.get(entry.path);
    if (text === undefined) throw new Error(`File not found: ${entry.path}`);
    return text;
  }
  async create(path: string, content: string): Promise<VaultEntry> {
    if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
    this.files.set(path, content);
    return { path, raw: path };
  }
  async modify(entry: VaultEntry, content: string): Promise<void> {
    if (!this.files.has(entry.path)) throw new Error(`File not found: ${entry.path}`);
    this.files.set(entry.path, content);
  }
  async createFolder(path: string): Promise<void> { this.folders.add(path); }
  async rename(): Promise<void> { throw new Error("unused"); }
}

const VALID_ANNOTATION = "Books/Apple Books/Author/Book/Annotations/Note.md";
const VALID_CONTENT = "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now";

// --- marker-free rendering ---

test("renderCompanionResearchContent produces synthesis and ## Sources without markers", () => {
  const content = renderCompanionResearchContent({
    synthesis: "Grounded claim [1]",
    sources: [{ title: "Source A", url: "https://example.com/a", retrievedAt: "2026-01-01T00:00:00Z", highlights: [] }],
  });
  assert.ok(content);
  assert.ok(content.startsWith("Grounded claim [1]"));
  assert.ok(content.includes("## Sources"));
  assert.ok(!content.includes("### Sources"));
  assert.ok(!content.includes("## Research"));
  assert.ok(!content.includes("mindmap:research"));
});

test("renderCompanionResearchContent validates citations and rejects marker injection", () => {
  assert.equal(renderCompanionResearchContent({ synthesis: "No citation", sources: [{ title: "A", url: "https://example.com", retrievedAt: "now", highlights: [] }] }), null);
  assert.equal(renderCompanionResearchContent({ synthesis: "Out of range [2]", sources: [{ title: "A", url: "https://example.com", retrievedAt: "now", highlights: [] }] }), null);
  assert.equal(renderCompanionResearchContent({ synthesis: "<!-- mindmap:research:start --> [1]", sources: [{ title: "A", url: "https://example.com", retrievedAt: "now", highlights: [] }] }), null);
});

test("renderCompanionResearchContent includes author and publication metadata", () => {
  const content = renderCompanionResearchContent({
    synthesis: "Fact [1]",
    sources: [{ title: "Published Source", url: "https://example.com/p", author: "Jane Doe", publishedAt: "2026-01-15T00:00:00Z", retrievedAt: "2026-02-01T00:00:00Z", highlights: [] }],
  });
  assert.ok(content);
  assert.ok(content.includes("Author: Jane Doe"));
  assert.ok(content.includes("Published: 2026-01-15T00:00:00Z"));
  assert.ok(content.includes("Retrieved: 2026-02-01T00:00:00Z"));
});

// --- path validation ---

test("isValidAnnotationSourcePath accepts valid Reading annotation paths", () => {
  assert.equal(isValidAnnotationSourcePath(VALID_ANNOTATION), true);
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/J.K. Rowling/Harry Potter/Annotations/Magic is real.md"), true);
});

test("isValidAnnotationSourcePath accepts Unicode paths", () => {
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/Auteur/Le Livre/Annotations/Résumé.md"), true);
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/著者/本のタイトル/Annotations/引用.md"), true);
});

test("isValidAnnotationSourcePath rejects non-Reading paths", () => {
  assert.equal(isValidAnnotationSourcePath("Notes/Regular/Note.md"), false);
  assert.equal(isValidAnnotationSourcePath("Books/Other/Author/Book/Annotations/Note.md"), false);
});

test("isValidAnnotationSourcePath rejects non-Annotations paths", () => {
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/Author/Book/Research/Note.md"), false);
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/Author/Book/Other/Note.md"), false);
});

test("isValidAnnotationSourcePath rejects malformed paths", () => {
  assert.equal(isValidAnnotationSourcePath(""), false);
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/Author/Book/Annotations/"), false);
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/Author/Book/Annotations/Note.txt"), false);
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/Author/Annotations/Note.md"), false);
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/Author/Book/Annotations/Sub/Note.md"), false);
});

test("isValidAnnotationSourcePath rejects unsafe paths", () => {
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/../../../etc/passwd.md"), false);
  assert.equal(isValidAnnotationSourcePath("/Books/Apple Books/Author/Book/Annotations/Note.md"), false);
});

test("isValidAnnotationSourcePath rejects control characters and wikilink delimiters", () => {
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/Author/Book/Annotations/Note\x00.md"), false);
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/Author/Book/Annotations/No[te.md"), false);
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/Author/Book/Annotations/No]te.md"), false);
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/Author/Book/Annotations/No|te.md"), false);
  assert.equal(isValidAnnotationSourcePath("Books/Apple Books/Au[thor/Book/Annotations/Note.md"), false);
});

// --- companion path derivation ---

test("companionPathForAnnotation derives Research sibling path", () => {
  assert.equal(companionPathForAnnotation(VALID_ANNOTATION), "Books/Apple Books/Author/Book/Research/Note.md");
});

test("companionPathForAnnotation handles collision suffixes", () => {
  assert.equal(companionPathForAnnotation("Books/Apple Books/A/B/Annotations/Title.md", 0), "Books/Apple Books/A/B/Research/Title.md");
  assert.equal(companionPathForAnnotation("Books/Apple Books/A/B/Annotations/Title.md", 1), "Books/Apple Books/A/B/Research/Title · 2.md");
  assert.equal(companionPathForAnnotation("Books/Apple Books/A/B/Annotations/Title.md", 2), "Books/Apple Books/A/B/Research/Title · 3.md");
});

test("companionPathForAnnotation preserves Unicode in basename", () => {
  assert.equal(
    companionPathForAnnotation("Books/Apple Books/著者/本/Annotations/引用テスト.md"),
    "Books/Apple Books/著者/本/Research/引用テスト.md",
  );
});

test("companionPathForAnnotation rejects non-Reading annotation paths", () => {
  assert.throws(() => companionPathForAnnotation("Notes/Regular/Note.md"), /Invalid annotation source path/);
  assert.throws(() => companionPathForAnnotation("Books/Apple Books/Author/Book/Research/Note.md"), /Invalid annotation source path/);
});

// --- companion note rendering ---

test("renderCompanionNote produces frontmatter with type, source wikilink, and annotation_id", () => {
  const note = renderCompanionNote(VALID_ANNOTATION, "ABC-123", VALID_CONTENT);
  assert.ok(note.startsWith("---\n"));
  assert.ok(note.includes("type: mindmap-reading-research"));
  assert.ok(note.includes("[[Books/Apple Books/Author/Book/Annotations/Note]]"));
  assert.ok(note.includes("ABC-123"));
  assert.ok(note.includes("Claim [1]"));
  assert.ok(note.includes("## Sources"));
  assert.ok(!note.includes("## Research"));
  assert.ok(!note.includes("mindmap:research:start"));
});

test("renderCompanionNote rejects invalid annotation paths", () => {
  assert.throws(() => renderCompanionNote("Notes/Bad.md", "id-1", VALID_CONTENT), /Invalid annotation source path/);
});

test("renderCompanionNote rejects empty annotationId", () => {
  assert.throws(() => renderCompanionNote(VALID_ANNOTATION, "", VALID_CONTENT), /non-empty annotation_id/);
  assert.throws(() => renderCompanionNote(VALID_ANNOTATION, "   ", VALID_CONTENT), /non-empty annotation_id/);
});

test("renderCompanionNote rejects empty content", () => {
  assert.throws(() => renderCompanionNote(VALID_ANNOTATION, "id-1", ""), /non-empty research content/);
  assert.throws(() => renderCompanionNote(VALID_ANNOTATION, "id-1", "   \n  "), /non-empty research content/);
});

// --- vault writer: create ---

test("writeCompanionNote creates a new companion when no file exists", async () => {
  const vault = new MockVault();
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: VALID_CONTENT });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, "Books/Apple Books/Author/Book/Research/Note.md");
  assert.ok(vault.files.has(result.companionPath));
  const text = vault.files.get(result.companionPath)!;
  assert.ok(text.includes("annotation_id"));
  assert.ok(text.includes("id-1"));
});

// --- vault writer: update ---

test("writeCompanionNote updates an existing companion with matching annotation_id", async () => {
  const vault = new MockVault();
  vault.files.set("Books/Apple Books/Author/Book/Research/Note.md", renderCompanionNote(VALID_ANNOTATION, "id-1", "Old claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: old"));
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: "New claim [1]\n\n## Sources\n1. [B](<https://b.com>)\n   Retrieved: new" });
  assert.equal(result.action, "updated");
  assert.equal(result.companionPath, "Books/Apple Books/Author/Book/Research/Note.md");
  assert.ok(vault.files.get(result.companionPath)!.includes("New claim"));
});

// --- vault writer: unchanged ---

test("writeCompanionNote returns unchanged when content is identical", async () => {
  const vault = new MockVault();
  vault.files.set("Books/Apple Books/Author/Book/Research/Note.md", renderCompanionNote(VALID_ANNOTATION, "id-1", VALID_CONTENT));
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: VALID_CONTENT });
  assert.equal(result.action, "unchanged");
});

// --- vault writer: stored path reuse ---

test("writeCompanionNote reuses stored companion path when annotation_id matches", async () => {
  const vault = new MockVault();
  const storedPath = "Books/Apple Books/Author/Book/Research/Custom Name.md";
  vault.files.set(storedPath, renderCompanionNote(VALID_ANNOTATION, "id-1", "Old [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: old"));
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: VALID_CONTENT, storedCompanionPath: storedPath });
  assert.equal(result.action, "updated");
  assert.equal(result.companionPath, storedPath);
});

// --- vault writer: matching adoption via probing ---

test("writeCompanionNote adopts an existing companion with matching annotation_id at derived path", async () => {
  const vault = new MockVault();
  vault.files.set("Books/Apple Books/Author/Book/Research/Note.md", renderCompanionNote(VALID_ANNOTATION, "id-1", "Old [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: old"));
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: "Updated [1]\n\n## Sources\n1. [B](<https://b.com>)\n   Retrieved: new" });
  assert.equal(result.action, "updated");
  assert.equal(result.companionPath, "Books/Apple Books/Author/Book/Research/Note.md");
});

// --- vault writer: unrelated collision preservation ---

test("writeCompanionNote skips occupied slots with different annotation_id", async () => {
  const vault = new MockVault();
  vault.files.set("Books/Apple Books/Author/Book/Research/Note.md", renderCompanionNote("Books/Apple Books/Author/Book/Annotations/Other.md", "id-other", "Other [1]\n\n## Sources\n1. [X](<https://x.com>)\n   Retrieved: now"));
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: VALID_CONTENT });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, "Books/Apple Books/Author/Book/Research/Note · 2.md");
  assert.ok(vault.files.get("Books/Apple Books/Author/Book/Research/Note.md")!.includes("id-other"));
});

// --- vault writer: folder creation ---

test("writeCompanionNote creates intermediate folders", async () => {
  const vault = new MockVault();
  await writeCompanionNote(vault, { annotationPath: "Books/Apple Books/New Author/New Book/Annotations/Note.md", annotationId: "id-1", content: VALID_CONTENT });
  assert.ok(vault.folders.has("Books/Apple Books"));
  assert.ok(vault.folders.has("Books/Apple Books/New Author"));
  assert.ok(vault.folders.has("Books/Apple Books/New Author/New Book"));
  assert.ok(vault.folders.has("Books/Apple Books/New Author/New Book/Research"));
});

// --- vault writer: rejection ---

test("writeCompanionNote rejects non-Reading annotation paths", async () => {
  const vault = new MockVault();
  await assert.rejects(() => writeCompanionNote(vault, { annotationPath: "Notes/Regular/Note.md", annotationId: "id-1", content: VALID_CONTENT }), /Invalid annotation source path/);
});

test("writeCompanionNote rejects non-Annotations source paths", async () => {
  const vault = new MockVault();
  await assert.rejects(() => writeCompanionNote(vault, { annotationPath: "Books/Apple Books/Author/Book/Research/Note.md", annotationId: "id-1", content: VALID_CONTENT }), /Invalid annotation source path/);
});

test("writeCompanionNote rejects empty annotationId", async () => {
  const vault = new MockVault();
  await assert.rejects(() => writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "", content: VALID_CONTENT }), /non-empty annotation_id/);
});

test("writeCompanionNote rejects empty content", async () => {
  const vault = new MockVault();
  await assert.rejects(() => writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: "" }), /non-empty research content/);
});

// --- stored path: traversal rejection ---

test("writeCompanionNote ignores stored path with traversal and falls through to probing", async () => {
  const vault = new MockVault();
  const traversalPath = "Books/Apple Books/Author/Book/Research/../../etc/evil.md";
  vault.files.set(traversalPath, renderCompanionNote(VALID_ANNOTATION, "id-1", VALID_CONTENT));
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: VALID_CONTENT, storedCompanionPath: traversalPath });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, "Books/Apple Books/Author/Book/Research/Note.md");
  assert.ok(vault.files.has(traversalPath), "traversal file must not be modified");
});

// --- stored path: other-book folder rejection ---

test("writeCompanionNote ignores stored path in a different book folder", async () => {
  const vault = new MockVault();
  const otherBookPath = "Books/Apple Books/Author/OtherBook/Research/Note.md";
  vault.files.set(otherBookPath, renderCompanionNote(VALID_ANNOTATION, "id-1", VALID_CONTENT));
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: VALID_CONTENT, storedCompanionPath: otherBookPath });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, "Books/Apple Books/Author/Book/Research/Note.md");
  assert.ok(vault.files.has(otherBookPath), "other-book file must not be modified");
});

// --- stored path: Annotations-folder rejection ---

test("writeCompanionNote ignores stored path inside Annotations folder", async () => {
  const vault = new MockVault();
  const annotationsPath = "Books/Apple Books/Author/Book/Annotations/Companion.md";
  vault.files.set(annotationsPath, renderCompanionNote(VALID_ANNOTATION, "id-1", VALID_CONTENT));
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: VALID_CONTENT, storedCompanionPath: annotationsPath });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, "Books/Apple Books/Author/Book/Research/Note.md");
});

// --- stored path: ordinary note path rejection ---

test("writeCompanionNote ignores stored path pointing to an ordinary note location", async () => {
  const vault = new MockVault();
  const ordinaryPath = "Notes/some-note.md";
  vault.files.set(ordinaryPath, renderCompanionNote(VALID_ANNOTATION, "id-1", VALID_CONTENT));
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: VALID_CONTENT, storedCompanionPath: ordinaryPath });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, "Books/Apple Books/Author/Book/Research/Note.md");
  assert.ok(vault.files.has(ordinaryPath), "ordinary note must not be modified");
});

// --- stored path: wikilink delimiter injection rejection ---

test("writeCompanionNote ignores stored path with wikilink delimiters", async () => {
  const vault = new MockVault();
  const injectedPath = "Books/Apple Books/Author/Book/Research/Evil]][[Inject.md";
  vault.files.set(injectedPath, renderCompanionNote(VALID_ANNOTATION, "id-1", VALID_CONTENT));
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: VALID_CONTENT, storedCompanionPath: injectedPath });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, "Books/Apple Books/Author/Book/Research/Note.md");
  assert.ok(vault.files.has(injectedPath), "injected file must not be modified");
});

test("writeCompanionNote ignores stored path with pipe delimiter", async () => {
  const vault = new MockVault();
  const pipePath = "Books/Apple Books/Author/Book/Research/Evil|alias.md";
  vault.files.set(pipePath, renderCompanionNote(VALID_ANNOTATION, "id-1", VALID_CONTENT));
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: VALID_CONTENT, storedCompanionPath: pipePath });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, "Books/Apple Books/Author/Book/Research/Note.md");
});

// --- probing: unreadable entries treated as occupied ---

test("writeCompanionNote treats unreadable entries as occupied and continues to next suffix", async () => {
  const vault = new MockVault();
  vault.unreadable.add("Books/Apple Books/Author/Book/Research/Note.md");
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: VALID_CONTENT });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, "Books/Apple Books/Author/Book/Research/Note · 2.md");
});

// --- probing: folders treated as occupied ---

test("writeCompanionNote treats folder entries as occupied and continues", async () => {
  const vault = new MockVault();
  vault.folders.add("Books/Apple Books/Author/Book/Research/Note.md");
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: VALID_CONTENT });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, "Books/Apple Books/Author/Book/Research/Note · 2.md");
});

// --- stored path: non-matching annotation_id falls through ---

test("writeCompanionNote falls through stored path when annotation_id does not match", async () => {
  const vault = new MockVault();
  vault.files.set("Books/Apple Books/Author/Book/Research/Stored.md", renderCompanionNote("Books/Apple Books/Author/Book/Annotations/Other.md", "id-wrong", "Wrong [1]\n\n## Sources\n1. [X](<https://x.com>)\n   Retrieved: old"));
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: VALID_CONTENT, storedCompanionPath: "Books/Apple Books/Author/Book/Research/Stored.md" });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, "Books/Apple Books/Author/Book/Research/Note.md");
});

test("writeCompanionNote stored path missing file falls through to probing", async () => {
  const vault = new MockVault();
  const result = await writeCompanionNote(vault, { annotationPath: VALID_ANNOTATION, annotationId: "id-1", content: VALID_CONTENT, storedCompanionPath: "Books/Apple Books/Author/Book/Research/Gone.md" });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, "Books/Apple Books/Author/Book/Research/Note.md");
});

// --- legacy extraction: LF ---

test("extractLegacyInlineResearch extracts a complete LF research block", () => {
  const prefix = "---\ntype: apple-books-annotation\n---\n> Quote text\n\n";
  const suffix = "\nUser content\n";
  const block = `${RESEARCH_START}\n## Research\nClaim [1]\n\n### Sources\n1. [A](<https://a.com>)\n   Retrieved: now\n${RESEARCH_END}`;
  const text = `${prefix}${block}${suffix}`;
  const result = extractLegacyInlineResearch(text);
  assert.ok(result);
  assert.equal(result.annotationText, `${prefix}${suffix}`);
  assert.ok(result.companionContent.includes("Claim [1]"));
  assert.ok(result.companionContent.includes("## Sources"));
  assert.ok(!result.companionContent.includes("### Sources"));
  assert.ok(!result.companionContent.includes("## Research"));
  assert.ok(!result.companionContent.includes("mindmap:research:start"));
  assert.ok(!result.companionContent.includes("mindmap:research:end"));
});

// --- legacy extraction: CRLF ---

test("extractLegacyInlineResearch preserves CRLF in annotation text and normalizes companion", () => {
  const prefix = "---\r\ntype: apple-books-annotation\r\n---\r\n> Quote\r\n\r\n";
  const suffix = "\r\nUser content\r\n";
  const block = `${RESEARCH_START}\r\n## Research\r\nClaim [1]\r\n\r\n### Sources\r\n1. [A](<https://a.com>)\r\n   Retrieved: now\r\n${RESEARCH_END}`;
  const text = `${prefix}${block}${suffix}`;
  const result = extractLegacyInlineResearch(text);
  assert.ok(result);
  assert.ok(result.annotationText.startsWith("---\r\n"));
  assert.ok(result.annotationText.includes("> Quote\r\n"));
  assert.ok(result.annotationText.endsWith("User content\r\n"));
  assert.ok(result.companionContent.includes("Claim [1]"));
  assert.ok(result.companionContent.includes("## Sources"));
  assert.ok(!result.companionContent.includes("### Sources"));
});

// --- legacy extraction: no block ---

test("extractLegacyInlineResearch returns null when no research block exists", () => {
  assert.equal(extractLegacyInlineResearch("---\ntype: apple-books-annotation\n---\n> Quote text\n\nUser notes\n"), null);
});

// --- legacy extraction: orphan markers ---

test("extractLegacyInlineResearch refuses orphan start marker", () => {
  assert.throws(() => extractLegacyInlineResearch(`Some text\n${RESEARCH_START}\nContent\n`), /incomplete/i);
});

test("extractLegacyInlineResearch refuses orphan end marker", () => {
  assert.throws(() => extractLegacyInlineResearch(`Some text\n${RESEARCH_END}\nContent\n`), /incomplete/i);
});

// --- legacy extraction: duplicate pairs ---

test("extractLegacyInlineResearch refuses duplicate start markers", () => {
  const block = `${RESEARCH_START}\n## Research\nClaim [1]\n${RESEARCH_END}`;
  assert.throws(() => extractLegacyInlineResearch(`${block}\n${RESEARCH_START}\nExtra\n`), /incomplete|duplicated/i);
});

test("extractLegacyInlineResearch refuses duplicate end markers", () => {
  assert.throws(() => extractLegacyInlineResearch(`${RESEARCH_START}\nContent\n${RESEARCH_END}\nMore\n${RESEARCH_END}\n`), /incomplete|duplicated/i);
});

test("extractLegacyInlineResearch refuses duplicate complete pairs", () => {
  const block = `${RESEARCH_START}\n## Research\nClaim [1]\n### Sources\n1. [A](<https://a.com>)\n   Retrieved: now\n${RESEARCH_END}`;
  assert.throws(() => extractLegacyInlineResearch(`${block}\n${block}\n`), /incomplete|duplicated/i);
});

// --- legacy extraction: reversed markers ---

test("extractLegacyInlineResearch refuses reversed markers", () => {
  assert.throws(() => extractLegacyInlineResearch(`${RESEARCH_END}\nContent\n${RESEARCH_START}\n`), /wrong order|incomplete|duplicated/i);
});

// --- legacy extraction: empty cleaned companion ---

test("extractLegacyInlineResearch refuses empty companion content after stripping", () => {
  assert.throws(() => extractLegacyInlineResearch(`Before\n${RESEARCH_START}\n## Research\n\n${RESEARCH_END}\nAfter\n`), /no usable content/i);
});

// --- legacy extraction: prefix/suffix preservation ---

test("extractLegacyInlineResearch preserves exact prefix and suffix bytes", () => {
  const prefix = "exact prefix bytes\r\n";
  const suffix = "\r\nexact suffix bytes\r\n";
  const block = `${RESEARCH_START}\n## Research\nFact [1]\n\n### Sources\n1. [S](<https://s.com>)\n   Retrieved: now\n${RESEARCH_END}`;
  const result = extractLegacyInlineResearch(`${prefix}${block}${suffix}`);
  assert.ok(result);
  assert.ok(result.annotationText.startsWith(prefix));
  assert.ok(result.annotationText.endsWith(suffix));
});

// --- legacy extraction: structural heading stripping only ---

test("extractLegacyInlineResearch strips only the first structural headings, not later occurrences", () => {
  const block = `${RESEARCH_START}\n## Research\nSynthesis mentions ## Research in a quote [1]\n\n### Sources\n1. [A](<https://a.com>)\n   Retrieved: now\n   This mentions ### Sources again\n${RESEARCH_END}`;
  const result = extractLegacyInlineResearch(block);
  assert.ok(result);
  assert.ok(result.companionContent.includes("## Research in a quote"));
  assert.ok(result.companionContent.includes("### Sources again"));
  assert.ok(!result.companionContent.startsWith("## Research\n"));
  const sourcesHeadingCount = (result.companionContent.match(/^## Sources$/gm) ?? []).length;
  assert.equal(sourcesHeadingCount, 1);
});

test("extractLegacyInlineResearch preserves all headings when structural ## Research is absent", () => {
  const block = `${RESEARCH_START}\nSynthesis [1]\n\n## Research mentioned later\n\n### Sources\n1. [A](<https://a.com>)\n   Retrieved: now\n${RESEARCH_END}`;
  const result = extractLegacyInlineResearch(block);
  assert.ok(result);
  assert.ok(result.companionContent.includes("## Research mentioned later"));
  assert.ok(result.companionContent.includes("### Sources"));
  assert.equal((result.companionContent.match(/^## Sources$/gm) ?? []).length, 0, "no converted ## Sources heading");
});
