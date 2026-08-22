import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyResearchTarget,
  completeAppleAnnotationResearchForNote,
  importAppleBooksAnnotations,
  renderAnnotationNote,
  updateAppleAnnotationResearchStatus,
  writeAppleAnnotationCompanion,
  type AnnotationImportResult,
} from "./appleBooksImport";
import type { ReadingStateStore } from "./readingState";
import { persistAutomaticResearchOutcome, selectAutomaticResearchCandidates } from "./automaticResearch";
import {
  annotationContentHash,
  annotationPathCandidate,
  baseAnnotationNotePath,
  bookFolderForNotePath,
  bookIndexPath,
  createEmptyReadingState,
  isValidResearchPathForNote,
  READING_INDEX_END,
  READING_INDEX_START,
  READING_SOURCE_END,
  READING_SOURCE_START,
  parseReadingState,
  READING_STATE_VERSION,
  type AppleBooksAnnotation,
  type AppleBooksReaderPayload,
  type ReadingState,
} from "./readingTypes";
import { deriveHumanTitle, humanTitleCandidate } from "./readingNoteFormat";
import type { ReadingVault, VaultEntry } from "./readingVault";
import { RESEARCH_END, RESEARCH_START } from "./researchWriter";

class MemoryVault implements ReadingVault {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  readonly modified: string[] = [];
  failCreatePath: string | null = null;
  failRenamePath: string | null = null;
  failModifyPath: string | null = null;
  failReadPath: string | null = null;
  /** When true, the next get() for a just-renamed path returns null once, simulating a transient post-rename lookup miss. */
  simulateGetMissAfterRename = false;
  private pendingGetMiss: string | null = null;

  get(path: string): VaultEntry | null {
    if (path === this.pendingGetMiss) {
      this.pendingGetMiss = null;
      return null;
    }
    if (this.files.has(path) || this.folders.has(path)) {
      return { path, raw: path };
    }
    return null;
  }

  async read(entry: VaultEntry): Promise<string> {
    if (entry.path === this.failReadPath) {
      throw new Error(`read failed: ${entry.path}`);
    }
    // A synthesized post-rename entry may carry the pre-rename raw identity; fall back to its
    // (already-correct) path, mirroring how a real TFile stays readable through its own object
    // reference even when a wrapper was built from a stale raw value.
    const content = this.files.get(String(entry.raw)) ?? this.files.get(entry.path);
    if (content === undefined) {
      throw new Error(`Missing file: ${entry.path}`);
    }
    return content;
  }

  async create(path: string, content: string): Promise<VaultEntry> {
    if (path === this.failCreatePath) {
      throw new Error(`create failed: ${path}`);
    }
    if (this.files.has(path) || this.folders.has(path)) {
      throw new Error(`already exists: ${path}`);
    }
    this.files.set(path, content);
    return { path, raw: path };
  }

  async modify(entry: VaultEntry, content: string): Promise<void> {
    if (this.failModifyPath !== null && entry.path === this.failModifyPath) {
      throw new Error(`modify failed: ${entry.path}`);
    }
    this.files.set(entry.path, content);
    this.modified.push(entry.path);
  }

  async createFolder(path: string): Promise<void> {
    this.folders.add(path);
  }

  async rename(entry: VaultEntry, newPath: string): Promise<void> {
    if (this.failRenamePath !== null && (entry.path === this.failRenamePath || newPath === this.failRenamePath)) {
      throw new Error(`rename failed: ${entry.path} -> ${newPath}`);
    }
    const content = this.files.get(entry.path);
    if (content === undefined) {
      throw new Error(`rename source missing: ${entry.path}`);
    }
    if (this.files.has(newPath) || this.folders.has(newPath)) {
      throw new Error(`rename target exists: ${newPath}`);
    }
    this.files.delete(entry.path);
    this.files.set(newPath, content);
    if (this.simulateGetMissAfterRename) {
      this.pendingGetMiss = newPath;
    }
  }
}

class MemoryState implements ReadingStateStore {
  current: ReadingState = createEmptyReadingState();
  saves = 0;
  saveAttempts = 0;
  failSave = false;
  failNextSave = false;
  failOnSaveAttempt: number | null = null;

  async load(): Promise<ReadingState> {
    return cloneState(this.current);
  }

  async save(state: ReadingState): Promise<void> {
    this.saveAttempts += 1;
    if (this.failSave || this.failNextSave || this.saveAttempts === this.failOnSaveAttempt) {
      this.failNextSave = false;
      throw new Error("state save failed");
    }
    this.current = cloneState(state);
    this.saves += 1;
  }

  async mutate<T>(fn: (state: ReadingState) => T | Promise<T>): Promise<{ state: ReadingState; result: T }> {
    const state = await this.load();
    const result = await fn(state);
    await this.save(state);
    return { state, result };
  }
}

function annotation(id: string, overrides: Partial<AppleBooksAnnotation> = {}): AppleBooksAnnotation {
  return {
    annotation_id: id,
    quote: "One two three four five six seven eight nine",
    book_title: "The Book",
    author: "Author",
    chapter: "Chapter 1",
    location: "12",
    created_at: "2026-08-17T00:00:00Z",
    ...overrides,
  };
}

/** Mirrors the importer's readable-path construction using only exported checkpoint-1 primitives. */
function readablePath(source: AppleBooksAnnotation, collisionIndex = 0): string {
  const title = deriveHumanTitle(source);
  return `Books/Apple Books/${source.author}/${source.book_title}/Annotations/${humanTitleCandidate(title, collisionIndex)}`;
}

/** A realistic pre-checkpoint-2 note: old opaque path content, old marker block, given newline convention. */
function legacyMarkerBody(source: AppleBooksAnnotation, opts: { newline?: string; following?: string[] } = {}): string {
  const newline = opts.newline ?? "\n";
  const lines = [
    "---",
    "type: apple-books-annotation",
    "source: apple-books",
    `annotation_id: ${source.annotation_id}`,
    `book_title: ${source.book_title}`,
    `book_author: ${source.author ?? ""}`,
    `chapter: ${source.chapter ?? ""}`,
    `created_at: ${source.created_at ?? ""}`,
    "imported_at: 2026-08-01T00:00:00Z",
    "research_status: off",
    "---",
    READING_SOURCE_START,
    "## Apple Books Source",
    "> **Quote**",
    `> ${source.quote}`,
    READING_SOURCE_END,
    ...(opts.following ?? []),
    "",
  ];
  return lines.join(newline);
}

function seedLegacyAnnotation(
  vault: MemoryVault,
  state: MemoryState,
  source: AppleBooksAnnotation,
  opts: { newline?: string; following?: string[]; legacyPath?: string } = {},
): string {
  const legacyPath = opts.legacyPath ?? baseAnnotationNotePath(source);
  vault.files.set(legacyPath, legacyMarkerBody(source, opts));
  state.current.annotations[source.annotation_id] = {
    contentHash: annotationContentHash(source),
    notePath: legacyPath,
    importedAt: "2026-08-01T00:00:00Z",
    researchStatus: "off",
    processedAt: null,
  };
  return legacyPath;
}

function payload(annotations: AppleBooksAnnotation[]): AppleBooksReaderPayload {
  return { version: 1, status: "success", annotations, diagnostics: [], count: annotations.length };
}

function cloneState(state: ReadingState): ReadingState {
  return JSON.parse(JSON.stringify(state)) as ReadingState;
}

async function runImport(
  vault: MemoryVault,
  state: MemoryState,
  annotations: AppleBooksAnnotation[],
  now = "2026-08-17T01:00:00Z",
): Promise<AnnotationImportResult> {
  return await importAppleBooksAnnotations(payload(annotations), { vault, state, now: () => now });
}

test("imports one note with a readable filename, leading blockquote body, and location frontmatter", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("id-1");
  const result = await runImport(vault, state, [source]);
  const notePath = result.imported[0]?.notePath ?? "";
  const indexPath = result.indexPaths[0] ?? "";
  const text = vault.files.get(notePath) ?? "";

  assert.equal(result.failures.length, 0);
  assert.equal(result.imported[0]?.action, "created");
  assert.equal(notePath, readablePath(source));
  assert.match(text, /type: apple-books-annotation/);
  assert.match(text, /annotation_id: id-1/);
  assert.match(text, /location: 12/);
  assert.match(text, /^> One two three four five six seven eight nine$/m);
  assert.equal(text.includes(READING_SOURCE_START), false);
  assert.equal(text.includes("## Apple Books Source"), false);
  assert.equal(text.includes("# Annotation"), false);
  assert.match(vault.files.get(indexPath) ?? "", new RegExp(READING_INDEX_START));
  assert.match(vault.files.get(indexPath) ?? "", new RegExp(READING_INDEX_END));
  assert.equal(state.current.annotations["id-1"]?.notePath, notePath);
  assert.equal(result.initialImport, true);
  assert.equal(state.current.initialImportCompletedAt, "2026-08-17T01:00:00Z");

  const second = await runImport(vault, state, [source], "2026-08-18T01:00:00Z");
  assert.equal(second.initialImport, false);
});

test("index failure leaves initial import incomplete until a fully successful retry", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("initial-index-failure");
  const indexPath = bookIndexPath(bookFolderForNotePath(readablePath(source)));
  vault.failCreatePath = indexPath;

  const failed = await runImport(vault, state, [source]);
  assert.equal(failed.initialImport, true);
  assert.equal(failed.failures.some((failure) => failure.stage === "index"), true);
  assert.equal(state.current.initialImportCompletedAt, null);

  vault.failCreatePath = null;
  const retried = await runImport(vault, state, [source], "2026-08-18T01:00:00Z");
  assert.equal(retried.initialImport, true);
  assert.equal(retried.failures.length, 0);
  assert.equal(state.current.initialImportCompletedAt, "2026-08-18T01:00:00Z");
});

test("completion-marker save failure preserves explicit incomplete state", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("initial-marker-failure");
  state.failOnSaveAttempt = 3;

  const result = await runImport(vault, state, [source]);
  assert.equal(result.initialImport, true);
  assert.equal(result.failures.some((failure) => failure.stage === "state"), true);
  assert.equal(state.current.lastSyncAt, "2026-08-17T01:00:00Z");
  assert.equal(state.current.initialImportCompletedAt, null);
  assert.equal(parseReadingState(state.current).initialImportCompletedAt, null);
});

test("keeps the allocated readable path stable even when a later edit would derive a different title", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("stable-path");
  const first = await runImport(vault, state, [source]);
  const notePath = first.imported[0]!.notePath;

  const edited = await runImport(vault, state, [
    annotation("stable-path", { quote: "Completely different phrase entirely, four five six seven eight." }),
  ]);

  assert.equal(edited.imported[0]?.notePath, notePath);
  assert.equal(state.current.annotations["stable-path"]?.notePath, notePath);
  assert.match(vault.files.get(notePath) ?? "", /Completely different phrase/);
});

test("research status helper preserves CRLF prefix and suffix bytes outside the one frontmatter value", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const imported = await runImport(vault, state, [annotation("status")]);
  const notePath = imported.imported[0]!.notePath;
  const lf = vault.files.get(notePath)!;
  const before = `${lf.replace(/\n/g, "\r\n").replace("---\r\n", "---\r\nprefix_key: exact bytes\r\n")}suffix bytes\r\n`;
  vault.files.set(notePath, before);
  state.current.annotations.status!.processedAt = "done";
  await updateAppleAnnotationResearchStatus(vault, state, "status", "complete");
  const after = vault.files.get(notePath)!;
  assert.equal(after.replace(/research_status: complete/, "research_status: off"), before);
  assert.equal(after.startsWith("---\r\nprefix_key: exact bytes\r\n"), true);
  assert.equal(after.endsWith("suffix bytes\r\n"), true);
  assert.equal(state.current.annotations.status!.researchStatus, "complete");
  assert.equal(state.current.annotations.status!.processedAt, null);
  state.current.annotations.status!.processedAt = "already-processed";
  await updateAppleAnnotationResearchStatus(vault, state, "status", "retryable");
  assert.equal(state.current.annotations.status!.researchStatus, "retryable");
  assert.equal(state.current.annotations.status!.processedAt, "already-processed");
});

test("manual Apple completion updates durable status while ordinary notes do not touch Reading state", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const imported = await runImport(vault, state, [annotation("manual")]);
  const notePath = imported.imported[0]!.notePath;
  const beforeSaves = state.saves;

  assert.equal(await completeAppleAnnotationResearchForNote(vault, state, notePath), "updated");
  assert.equal(state.current.annotations.manual!.researchStatus, "complete");
  assert.match(vault.files.get(notePath) ?? "", /research_status: complete/);

  await vault.create("Notes/ordinary.md", "ordinary note\n");
  assert.equal(await completeAppleAnnotationResearchForNote(vault, state, "Notes/ordinary.md"), false);
  assert.equal(state.saves, beforeSaves + 1);
});

test("durable complete frontmatter is adopted after its state save fails and excludes provider candidates", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("adopt-complete");
  const first = await runImport(vault, state, [source]);
  const notePath = first.imported[0]!.notePath;
  state.failNextSave = true;

  assert.equal(await updateAppleAnnotationResearchStatus(vault, state, "adopt-complete", "complete"), "state-pending");
  assert.equal(state.current.annotations["adopt-complete"]!.researchStatus, "off");
  assert.match(vault.files.get(notePath) ?? "", /research_status: complete/);

  await runImport(vault, state, [source]);
  assert.equal(state.current.annotations["adopt-complete"]!.researchStatus, "complete");
});

test("rejects malformed reader payloads before any Vault or state write", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  await assert.rejects(
    () => importAppleBooksAnnotations({
      version: 1,
      status: "success",
      count: 1,
      annotations: [{ ...annotation("bad"), quote: "" }],
      diagnostics: [],
    }, { vault, state }),
    /quote/,
  );
  assert.equal(vault.files.size, 0);
  assert.equal(state.saves, 0);
});

test("adopts a note orphaned by a state-save failure instead of creating a collision", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("orphan");
  state.failNextSave = true;

  const first = await runImport(vault, state, [source]);
  const expectedPath = readablePath(source);
  assert.equal(first.failures[0]?.stage, "state");
  assert.equal(vault.files.has(expectedPath), true);
  assert.equal(Object.prototype.hasOwnProperty.call(state.current.annotations, "orphan"), false);

  const retry = await runImport(vault, state, [source]);
  const annotationNotes = [...vault.files.keys()].filter((path) => path.includes("/Annotations/") && path.endsWith(".md"));
  assert.equal(retry.failures.length, 0);
  assert.deepEqual(annotationNotes, [expectedPath]);
  const repairedEntry = state.current.annotations["orphan"];
  assert.ok(repairedEntry);
  assert.equal(repairedEntry.notePath, expectedPath);
});

test("probes readable candidates deterministically and never touches unrelated occupants", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("occupied");
  const basePath = readablePath(source, 0);
  const firstFallbackPath = readablePath(source, 1);
  const nextPath = readablePath(source, 2);
  const baseBytes = "unrelated base note bytes\n";
  const fallbackBytes = "unrelated fallback note bytes\n";
  vault.files.set(basePath, baseBytes);
  vault.files.set(firstFallbackPath, fallbackBytes);

  const result = await runImport(vault, state, [source]);

  assert.equal(result.failures.length, 0);
  assert.equal(result.imported[0]?.notePath, nextPath);
  assert.equal(vault.files.get(basePath), baseBytes);
  assert.equal(vault.files.get(firstFallbackPath), fallbackBytes);
  assert.equal(vault.modified.includes(basePath), false);
  assert.equal(vault.modified.includes(firstFallbackPath), false);
  assert.equal(state.current.annotations.occupied?.notePath, nextPath);
});

test("duplicate imports are no-ops and edits replace only the leading blockquote", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const first = await runImport(vault, state, [annotation("id-1")]);
  const notePath = first.imported[0]!.notePath;
  vault.files.set(notePath, `${vault.files.get(notePath)}\nUser body.\n`);

  const duplicate = await runImport(vault, state, [annotation("id-1")]);
  assert.equal(duplicate.imported[0]?.action, "unchanged");

  const edited = await runImport(vault, state, [annotation("id-1", { quote: "Changed quote one two three four five six seven eight nine" })]);
  const editedText = vault.files.get(notePath) ?? "";
  assert.equal(edited.imported[0]?.action, "updated");
  assert.match(editedText, /Changed quote/);
  assert.doesNotMatch(editedText, /One two three/);
  assert.match(editedText, /User body/);
});

test("ten annotation import cycles keep one stable note and preserve user content", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const initial = annotation("ten-cycle");
  const first = await runImport(vault, state, [initial]);
  const notePath = first.imported[0]!.notePath;
  vault.files.set(notePath, `${vault.files.get(notePath)}\nUser detail.\n`);

  for (let cycle = 0; cycle < 10; cycle += 1) {
    const source = annotation("ten-cycle", { quote: cycle % 2 === 0 ? initial.quote : `Cycle ${cycle} quote one two three four five six seven eight nine` });
    await runImport(vault, state, [source], `2026-08-17T0${cycle}:00:00Z`);
    const annotationPaths = [...vault.files.keys()].filter((candidate) => candidate.includes("/Annotations/") && candidate.endsWith(".md"));
    assert.deepEqual(annotationPaths, [notePath]);
    assert.equal(state.current.annotations["ten-cycle"]?.notePath, notePath);
    assert.match(vault.files.get(notePath) ?? "", /User detail\./);
  }
});

test("changed source migrates inline research to companion, resets status, and removes research property", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const first = await runImport(vault, state, [annotation("changed-research")]);
  const notePath = first.imported[0]!.notePath;
  vault.files.set(notePath, `${vault.files.get(notePath)}\n<!-- mindmap:research:start -->\n## Research\nOld valid research. [1]\n\n### Sources\n1. [A](<https://a.com>)\n   Retrieved: now\n<!-- mindmap:research:end -->\n`);
  await updateAppleAnnotationResearchStatus(vault, state, "changed-research", "complete");

  await runImport(vault, state, [annotation("changed-research", { quote: "Changed quote one two three four five six seven eight nine" })]);
  const changed = vault.files.get(notePath) ?? "";
  assert.equal(changed.includes("mindmap:research:start"), false, "inline research block removed");
  assert.match(changed, /research_status: off/);
  assert.doesNotMatch(changed, /^research:/m, "research property removed on source change");
  assert.equal(state.current.annotations["changed-research"]!.researchStatus, "off");
  assert.equal(state.current.annotations["changed-research"]!.processedAt, null);
  const companionPath = state.current.annotations["changed-research"]!.researchPath;
  assert.ok(companionPath, "researchPath retained for reuse");
  assert.ok(vault.files.has(companionPath!), "companion note created");
  assert.match(vault.files.get(companionPath!) ?? "", /Old valid research\. \[1\]/);
});

test("imports too-short annotations without queue eligibility and retains notes after source deletion", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const short = await runImport(vault, state, [annotation("short", { quote: "one two", user_note: "three" })]);
  const notePath = short.imported[0]!.notePath;

  assert.equal(short.imported[0]?.tooShort, true);
  assert.equal(short.imported[0]?.eligible, false);
  assert.equal(state.current.annotations.short?.researchStatus, "too-short");
  assert.match(vault.files.get(notePath) ?? "", /research_status: too-short/);

  const deleted = await runImport(vault, state, []);
  assert.equal(deleted.failures.length, 0);
  assert.equal(deleted.state.annotations.short?.notePath, notePath);
  assert.equal(vault.files.has(notePath), true);
});

test("unchanged too-short annotations reject a manually completed durable status and remain excluded", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("short-complete", { quote: "one two", user_note: "three" });
  const first = await runImport(vault, state, [source]);
  const notePath = first.imported[0]!.notePath;
  vault.files.set(notePath, vault.files.get(notePath)!.replace("research_status: too-short", "research_status: complete"));

  await runImport(vault, state, [source]);

  assert.equal(state.current.annotations["short-complete"]!.researchStatus, "too-short");
  assert.match(vault.files.get(notePath) ?? "", /research_status: too-short/);
  assert.deepEqual(selectAutomaticResearchCandidates(state.current.annotations), []);
});

test("removes generated summary/tags, preserves unrelated frontmatter, and safely renders marker-like quote text", () => {
  const text = renderAnnotationNote(
    "---\nsummary: Keep this\ntags:\n  - user\nkeep_me: yes\n---\nUser content.\n",
    annotation("id-1", { quote: `Quote\n${READING_SOURCE_END}` }),
    { importedAt: "2026-08-17T01:00:00Z", researchStatus: "off" },
  );

  assert.doesNotMatch(text, /^summary:/m);
  assert.doesNotMatch(text, /^tags:/m);
  assert.doesNotMatch(text, /- user/);
  assert.match(text, /keep_me: yes/);
  assert.match(text, /User content/);
  assert.equal(text.includes(READING_SOURCE_START), false);
  assert.equal((text.match(/^> <!-- mindmap:apple-books-source:end -->$/gm) ?? []).length, 1);
  assert.equal((text.match(new RegExp(`^${READING_SOURCE_END}$`, "gm")) ?? []).length, 0);
});

test("converts existing block-list concepts and related values to readable wikilinks, dropping unsafe targets", () => {
  const source = annotation("links-1");
  const existingText = [
    "---",
    "concepts:",
    '  - "behavior change"',
    "  - Teaching",
    "related:",
    "  - Books/Apple Books/Author/The Book/Annotations/Other note.md",
    "  - Books/Apple Books/Author/../../etc/passwd.md",
    "---",
    "User content.",
    "",
  ].join("\n");

  const text = renderAnnotationNote(existingText, source, { importedAt: "2026-08-17T01:00:00Z", researchStatus: "off" });

  assert.match(text, /concepts:\n {2}- "\[\[behavior change\]\]"\n {2}- "\[\[Teaching\]\]"/);
  assert.match(text, /related:\n {2}- "\[\[Books\/Apple Books\/Author\/The Book\/Annotations\/Other note\|Other note\]\]"/);
  assert.doesNotMatch(text, /etc\/passwd/);
  assert.match(text, /User content/);
});

test("leaves an unfamiliar concepts/related shape untouched instead of corrupting frontmatter", () => {
  const source = annotation("links-2");
  const existingText = [
    "---",
    "concepts: [alpha, beta]",
    "related: single-value.md",
    "---",
    "Body text.",
    "",
  ].join("\n");

  const text = renderAnnotationNote(existingText, source, { importedAt: "2026-08-17T01:00:00Z", researchStatus: "off" });

  assert.match(text, /concepts: \[alpha, beta\]/);
  assert.match(text, /related: single-value\.md/);
  assert.match(text, /Body text/);
});

test("migrates an old CRLF marker block to the leading blockquote and preserves following content byte-for-byte", () => {
  const source = annotation("crlf-migrate");
  const existingText = [
    "---",
    "type: apple-books-annotation",
    `annotation_id: ${source.annotation_id}`,
    "research_status: off",
    "---",
    READING_SOURCE_START,
    "## Apple Books Source",
    "> **Quote**",
    "> old quote",
    READING_SOURCE_END,
    "Rest of body",
    "Second line",
    "",
  ].join("\r\n");

  const text = renderAnnotationNote(existingText, source, { importedAt: "2026-08-17T01:00:00Z", researchStatus: "off" });

  assert.equal(text.includes(READING_SOURCE_START), false);
  assert.ok(text.endsWith("> One two three four five six seven eight nine\r\nRest of body\r\nSecond line\r\n"));
});

test("refuses to import a note with an incomplete old marker block, leaving the file and state untouched", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("bad-marker");
  const targetPath = readablePath(source);
  const badBody = `---\ntype: apple-books-annotation\nannotation_id: ${source.annotation_id}\n---\n${READING_SOURCE_START}\nsome content without an end marker\n`;
  vault.files.set(targetPath, badBody);

  const result = await runImport(vault, state, [source]);

  assert.equal(result.failures.some((failure) => failure.annotationId === "bad-marker" && failure.stage === "note"), true);
  assert.equal(vault.files.get(targetPath), badBody);
  assert.equal(Object.prototype.hasOwnProperty.call(state.current.annotations, "bad-marker"), false);
});

test("migrates a legacy opaque path to the readable scheme, converting the note body along the way", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-1");
  const legacyPath = seedLegacyAnnotation(vault, state, source);
  const expectedPath = readablePath(source);

  const result = await runImport(vault, state, [source]);

  assert.equal(result.failures.length, 0);
  assert.equal(result.imported[0]?.notePath, expectedPath);
  assert.equal(result.imported[0]?.action, "updated");
  assert.equal(vault.files.has(legacyPath), false);
  assert.equal(vault.files.has(expectedPath), true);
  assert.equal(state.current.annotations["legacy-1"]?.notePath, expectedPath);
  const text = vault.files.get(expectedPath) ?? "";
  assert.equal(text.includes(READING_SOURCE_START), false);
  assert.match(text, /> One two three four five six seven eight nine/);
});

test("keeps and updates the old stable path when a legacy rename fails", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-fail");
  const legacyPath = seedLegacyAnnotation(vault, state, source);
  vault.failRenamePath = legacyPath;

  const result = await runImport(vault, state, [source]);

  assert.equal(result.failures.length, 0);
  assert.equal(result.imported[0]?.notePath, legacyPath);
  assert.equal(state.current.annotations["legacy-fail"]?.notePath, legacyPath);
  const text = vault.files.get(legacyPath) ?? "";
  assert.equal(text.includes(READING_SOURCE_START), false);
  assert.match(text, /> One two three four five six seven eight nine/);
});

test("probes readable migration candidates and skips an unrelated occupant", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-collide");
  const legacyPath = seedLegacyAnnotation(vault, state, source);
  const firstCandidate = readablePath(source, 0);
  const unrelatedBytes = "unrelated note bytes\n";
  vault.files.set(firstCandidate, unrelatedBytes);

  const result = await runImport(vault, state, [source]);
  const expectedPath = readablePath(source, 1);

  assert.equal(result.failures.length, 0);
  assert.equal(result.imported[0]?.notePath, expectedPath);
  assert.equal(vault.files.get(firstCandidate), unrelatedBytes);
  assert.equal(vault.modified.includes(firstCandidate), false);
  assert.equal(vault.files.has(legacyPath), false);
});

test("adopts a note migrated by a prior sync whose state save failed, without creating a duplicate", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-orphan");
  const legacyPath = seedLegacyAnnotation(vault, state, source);
  state.failNextSave = true;

  const first = await runImport(vault, state, [source]);
  const expectedPath = readablePath(source);
  assert.equal(first.failures[0]?.stage, "state");
  assert.equal(vault.files.has(legacyPath), false);
  assert.equal(vault.files.has(expectedPath), true);
  assert.equal(state.current.annotations["legacy-orphan"]?.notePath, legacyPath);

  const retry = await runImport(vault, state, [source]);
  const annotationNotes = [...vault.files.keys()].filter((path) => path.includes("/Annotations/") && path.endsWith(".md"));
  assert.equal(retry.failures.length, 0);
  assert.deepEqual(annotationNotes, [expectedPath]);
  assert.equal(state.current.annotations["legacy-orphan"]?.notePath, expectedPath);
});

test("migrates a legacy collision-1 path (date-shortid-shortid.md) to the readable scheme", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-collision-1");
  const legacyPath = annotationPathCandidate(source, 1);
  assert.notEqual(legacyPath, baseAnnotationNotePath(source));
  seedLegacyAnnotation(vault, state, source, { legacyPath });
  const expectedPath = readablePath(source);

  const result = await runImport(vault, state, [source]);

  assert.equal(result.failures.length, 0);
  assert.equal(result.imported[0]?.notePath, expectedPath);
  assert.equal(vault.files.has(legacyPath), false);
  assert.equal(vault.files.has(expectedPath), true);
  assert.equal(state.current.annotations["legacy-collision-1"]?.notePath, expectedPath);
});

test("migrates a legacy numbered collision path (date-shortid-shortid-N.md) to the readable scheme", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-collision-3");
  const legacyPath = annotationPathCandidate(source, 3);
  seedLegacyAnnotation(vault, state, source, { legacyPath });
  const expectedPath = readablePath(source);

  const result = await runImport(vault, state, [source]);

  assert.equal(result.failures.length, 0);
  assert.equal(result.imported[0]?.notePath, expectedPath);
  assert.equal(vault.files.has(legacyPath), false);
  assert.equal(vault.files.has(expectedPath), true);
  assert.equal(state.current.annotations["legacy-collision-3"]?.notePath, expectedPath);
});

test("refuses to migrate a legacy note with an incomplete old marker block, leaving path and state byte-identical", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-bad-marker");
  const legacyPath = baseAnnotationNotePath(source);
  const badBody = `---\ntype: apple-books-annotation\nannotation_id: ${source.annotation_id}\nresearch_status: off\n---\n${READING_SOURCE_START}\nsome content without an end marker\n`;
  vault.files.set(legacyPath, badBody);
  const stateEntry = {
    contentHash: annotationContentHash(source),
    notePath: legacyPath,
    importedAt: "2026-08-01T00:00:00Z",
    researchStatus: "off" as const,
    processedAt: null,
  };
  state.current.annotations[source.annotation_id] = { ...stateEntry };

  const result = await runImport(vault, state, [source]);

  assert.equal(result.failures.some((failure) => failure.annotationId === "legacy-bad-marker" && failure.stage === "note"), true);
  assert.equal(vault.files.get(legacyPath), badBody);
  assert.equal(vault.files.has(readablePath(source)), false);
  assert.deepEqual(state.current.annotations["legacy-bad-marker"], stateEntry);
});

test("drops an existing related wikilink whose target is unsafe but preserves a valid one byte-for-byte", () => {
  const source = annotation("links-3");
  const validItem = '  - "[[Books/Apple Books/Author/The Book/Annotations/Kept note|Kept note]]"';
  const existingText = [
    "---",
    "related:",
    validItem,
    '  - "[[../../etc/passwd|passwd]]"',
    "---",
    "Body text.",
    "",
  ].join("\n");

  const text = renderAnnotationNote(existingText, source, { importedAt: "2026-08-17T01:00:00Z", researchStatus: "off" });

  assert.match(text, /related:\n {2}- "\[\[Books\/Apple Books\/Author\/The Book\/Annotations\/Kept note\|Kept note\]\]"\n/);
  assert.doesNotMatch(text, /etc\/passwd/);
  assert.match(text, /Body text/);
});

test("forces a render for a dirty-but-content-unchanged note, then stays a true no-op once clean", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("dirty-clean");
  const notePath = readablePath(source);
  const dirtyText = [
    "---",
    "type: apple-books-annotation",
    "source: apple-books",
    `annotation_id: ${source.annotation_id}`,
    `book_title: ${source.book_title}`,
    `book_author: ${source.author}`,
    `chapter: ${source.chapter}`,
    `created_at: ${source.created_at}`,
    "imported_at: 2026-08-01T00:00:00Z",
    "research_status: off",
    "summary: stale generated summary",
    "tags:",
    "  - old-tag",
    "concepts:",
    "  - raw concept",
    "---",
    `> ${source.quote}`,
    "",
  ].join("\n");
  vault.files.set(notePath, dirtyText);
  state.current.annotations[source.annotation_id] = {
    contentHash: annotationContentHash(source),
    notePath,
    importedAt: "2026-08-01T00:00:00Z",
    researchStatus: "off",
    processedAt: null,
  };

  const result = await runImport(vault, state, [source]);
  const cleanedText = vault.files.get(notePath) ?? "";

  assert.equal(result.imported[0]?.action, "updated");
  assert.doesNotMatch(cleanedText, /^summary:/m);
  assert.doesNotMatch(cleanedText, /^tags:/m);
  assert.match(cleanedText, /concepts:\n {2}- "\[\[raw concept\]\]"/);
  assert.match(cleanedText, /location: 12/);

  const modificationsBeforeSecondImport = vault.modified.length;
  const second = await runImport(vault, state, [source]);
  assert.equal(second.imported[0]?.action, "unchanged");
  assert.equal(vault.modified.length, modificationsBeforeSecondImport);
});

test("import-level: an unchanged note with only an orphan end marker is still routed to render and refused, not fast-pathed", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("orphan-end-marker");
  const notePath = readablePath(source);
  const orphanEndBody = `---\ntype: apple-books-annotation\nannotation_id: ${source.annotation_id}\nlocation: ${source.location}\nresearch_status: off\n---\nSome preface\n${READING_SOURCE_END}\n> ${source.quote}\n`;
  vault.files.set(notePath, orphanEndBody);
  state.current.annotations[source.annotation_id] = {
    contentHash: annotationContentHash(source),
    notePath,
    importedAt: "2026-08-01T00:00:00Z",
    researchStatus: "off",
    processedAt: null,
  };

  const result = await runImport(vault, state, [source]);

  assert.equal(result.failures.some((failure) => failure.annotationId === "orphan-end-marker" && failure.stage === "note"), true);
  assert.equal(vault.files.get(notePath), orphanEndBody);
});

test("import-level: an unchanged note whose related list still holds an unsafe existing wikilink is rendered and sanitized, not fast-pathed", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("dirty-related-unsafe");
  const notePath = readablePath(source);
  const dirtyText = [
    "---",
    "type: apple-books-annotation",
    "source: apple-books",
    `annotation_id: ${source.annotation_id}`,
    `book_title: ${source.book_title}`,
    `book_author: ${source.author}`,
    `chapter: ${source.chapter}`,
    `location: ${source.location}`,
    `created_at: ${source.created_at}`,
    "imported_at: 2026-08-01T00:00:00Z",
    "research_status: off",
    "related:",
    '  - "[[../../etc/passwd|passwd]]"',
    "---",
    `> ${source.quote}`,
    "",
  ].join("\n");
  vault.files.set(notePath, dirtyText);
  state.current.annotations[source.annotation_id] = {
    contentHash: annotationContentHash(source),
    notePath,
    importedAt: "2026-08-01T00:00:00Z",
    researchStatus: "off",
    processedAt: null,
  };
  const modificationsBefore = vault.modified.length;

  const result = await runImport(vault, state, [source]);
  const cleanedText = vault.files.get(notePath) ?? "";

  assert.equal(result.failures.length, 0);
  assert.equal(result.imported[0]?.action, "updated");
  assert.ok(vault.modified.length > modificationsBefore);
  assert.doesNotMatch(cleanedText, /etc\/passwd/);
});

test("does not migrate a stored path that matches the legacy short ID pattern but has a different date", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-wrong-date");
  const legacyBase = baseAnnotationNotePath(source);
  const folder = legacyBase.slice(0, legacyBase.lastIndexOf("/"));
  const shortId = /-([0-9a-f]{12})\.md$/.exec(legacyBase)?.[1];
  assert.ok(shortId);
  const wrongDatePath = `${folder}/2020-01-01-${shortId}.md`;
  assert.notEqual(wrongDatePath, legacyBase);
  vault.files.set(
    wrongDatePath,
    `---\ntype: apple-books-annotation\nannotation_id: ${source.annotation_id}\nlocation: ${source.location}\nresearch_status: off\n---\n> ${source.quote}\n`,
  );
  state.current.annotations[source.annotation_id] = {
    contentHash: annotationContentHash(source),
    notePath: wrongDatePath,
    importedAt: "2026-08-01T00:00:00Z",
    researchStatus: "off",
    processedAt: null,
  };

  const result = await runImport(vault, state, [source]);

  assert.equal(result.failures.length, 0);
  assert.equal(result.imported[0]?.notePath, wrongDatePath);
  assert.equal(result.imported[0]?.action, "unchanged");
  assert.equal(state.current.annotations["legacy-wrong-date"]?.notePath, wrongDatePath);
  assert.equal(vault.files.has(wrongDatePath), true);
});

test("retains a usable entry when a post-rename Vault lookup misses, instead of falling into create", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-lookup-miss");
  const legacyPath = seedLegacyAnnotation(vault, state, source);
  vault.simulateGetMissAfterRename = true;

  const result = await runImport(vault, state, [source]);
  const expectedPath = readablePath(source);

  assert.equal(result.failures.length, 0);
  assert.equal(result.imported[0]?.notePath, expectedPath);
  assert.equal(result.imported[0]?.action, "updated");
  assert.equal(vault.files.has(legacyPath), false);
  assert.equal(vault.files.has(expectedPath), true);
  assert.equal(state.current.annotations["legacy-lookup-miss"]?.notePath, expectedPath);
});

test("does not regenerate a book index from partial state when a rename-then-state-save fails, and repairs it on the next successful sync", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const stable = annotation("index-repair-stable", { quote: "Stable sibling annotation quote one two three four five" });
  await runImport(vault, state, [stable]);
  const indexPath = `Books/Apple Books/${stable.author}/${stable.book_title}/Index.md`;
  const indexBefore = vault.files.get(indexPath);
  assert.ok(indexBefore);

  const source = annotation("legacy-index-repair");
  const legacyPath = seedLegacyAnnotation(vault, state, source);
  state.failNextSave = true;

  const first = await runImport(vault, state, [source]);
  const expectedPath = readablePath(source);
  assert.equal(first.failures[0]?.stage, "state");
  assert.equal(first.indexPaths.length, 0);
  assert.equal(vault.files.get(indexPath), indexBefore);

  const retry = await runImport(vault, state, [source]);
  assert.equal(retry.failures.length, 0);
  assert.equal(retry.indexPaths.length, 1);
  const indexAfter = vault.files.get(indexPath) ?? "";
  assert.notEqual(indexAfter, indexBefore);
  assert.doesNotMatch(indexAfter, new RegExp(legacyPath.replace(/\.md$/, "").replace(/[.[\]().*+?^${}|\\]/g, "\\$&")));
  assert.match(indexAfter, new RegExp(expectedPath.replace(/\.md$/, "").replace(/[.[\]().*+?^${}|\\]/g, "\\$&")));
});

test("partial note failure commits prior annotations but does not advance failed state", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const second = annotation("id-2", { quote: "Second annotation quote one two three four five six" });
  const expectedSecond = readablePath(second);
  vault.failCreatePath = expectedSecond;

  const result = await runImport(vault, state, [annotation("id-1"), second]);

  assert.equal(result.failures.some((failure) => failure.annotationId === "id-2"), true);
  assert.equal(state.current.annotations["id-1"] !== undefined, true);
  assert.equal(state.current.annotations["id-2"], undefined);
  assert.equal(state.current.lastSyncAt, null);
});

test("per-annotation state failure preserves committed entries but keeps the prior sync cursor", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  state.current.lastSyncAt = "before";
  state.failNextSave = false;
  const originalSave = state.save.bind(state);
  let saveCount = 0;
  state.save = async (nextState) => {
    saveCount += 1;
    if (saveCount === 2) {
      throw new Error("state save failed on second annotation");
    }
    await originalSave(nextState);
  };

  const result = await runImport(vault, state, [annotation("id-1"), annotation("id-2")]);

  assert.equal(result.failures.some((failure) => failure.annotationId === "id-2" && failure.stage === "state"), true);
  assert.equal(state.current.annotations["id-1"] !== undefined, true);
  assert.equal(state.current.annotations["id-2"], undefined);
  assert.equal(state.current.lastSyncAt, "before");
});

test("unchanged fast-path modify failure is contained per-annotation and later annotations still import", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const first = annotation("id-1");
  const second = annotation("id-2", { quote: "Second annotation quote one two three four five six" });

  await runImport(vault, state, [first]);
  const notePath = state.current.annotations["id-1"]!.notePath;
  // Simulate a prior sync that already recorded this annotation as too-short while the note's
  // own frontmatter still says "off", forcing the unchanged fast-path to attempt a durable rewrite.
  state.current.annotations["id-1"]!.researchStatus = "too-short";
  state.current.lastSyncAt = "before";
  vault.failModifyPath = notePath;

  const result = await runImport(vault, state, [first, second]);

  assert.equal(result.failures.some((failure) => failure.annotationId === "id-1" && failure.stage === "modify"), true);
  assert.equal(state.current.annotations["id-1"]!.researchStatus, "too-short");
  assert.equal(result.imported.some((entry) => entry.annotationId === "id-2"), true);
  assert.equal(state.current.annotations["id-2"] !== undefined, true);
  assert.equal(state.current.lastSyncAt, "before");
});

test("unchanged fast-path read failure is contained per-annotation and later annotations still import", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const first = annotation("id-1");
  const second = annotation("id-2", { quote: "Second annotation quote one two three four five six" });

  await runImport(vault, state, [first]);
  state.current.lastSyncAt = "before";
  vault.failReadPath = state.current.annotations["id-1"]!.notePath;

  const result = await runImport(vault, state, [first, second]);

  assert.equal(result.failures.some((failure) => failure.annotationId === "id-1" && failure.stage === "note"), true);
  assert.equal(result.imported.some((entry) => entry.annotationId === "id-2"), true);
  assert.equal(state.current.annotations["id-2"] !== undefined, true);
  assert.equal(state.current.lastSyncAt, "before");
});

test("unchanged fast-path durable-complete mutate failure is contained per-annotation and later annotations still import", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const first = annotation("id-1");
  const second = annotation("id-2", { quote: "Second annotation quote one two three four five six" });

  await runImport(vault, state, [first]);
  const notePath = state.current.annotations["id-1"]!.notePath;
  state.failNextSave = true;
  assert.equal(await updateAppleAnnotationResearchStatus(vault, state, "id-1", "complete"), "state-pending");
  assert.equal(state.current.annotations["id-1"]!.researchStatus, "off");
  assert.match(vault.files.get(notePath) ?? "", /research_status: complete/);

  state.current.lastSyncAt = "before";
  state.failNextSave = true;

  const result = await runImport(vault, state, [first, second]);

  assert.equal(result.failures.some((failure) => failure.annotationId === "id-1" && failure.stage === "mutate"), true);
  assert.equal(state.current.annotations["id-1"]!.researchStatus, "off");
  assert.match(vault.files.get(notePath) ?? "", /research_status: complete/);
  assert.equal(result.imported.some((entry) => entry.annotationId === "id-2"), true);
  assert.equal(state.current.annotations["id-2"] !== undefined, true);
  assert.equal(state.current.lastSyncAt, "before");
});

// --- Checkpoint 3B: companion integration, state researchPath, legacy migration ---

test("writeAppleAnnotationCompanion creates companion, adds research property, and persists researchPath", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("companion-create");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["companion-create"]!.notePath;

  const result = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath,
    annotationId: "companion-create",
    researchContent: "Grounded claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.action, "created");
  assert.ok(result.companionPath.includes("/Research/"));
  assert.ok(vault.files.has(result.companionPath));
  const companionText = vault.files.get(result.companionPath)!;
  assert.match(companionText, /type: mindmap-reading-research/);
  assert.match(companionText, /Grounded claim \[1\]/);

  const noteText = vault.files.get(notePath)!;
  assert.match(noteText, /^research:/m);
  const researchLine = noteText.split("\n").find((l: string) => /^research:/.test(l))!;
  assert.ok(researchLine.includes("Research]]"));

  assert.equal(state.current.annotations["companion-create"]!.researchPath, result.companionPath);
});

test("writeAppleAnnotationCompanion updates existing companion and preserves stable path", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("companion-update");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["companion-update"]!.notePath;

  const first = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath,
    annotationId: "companion-update",
    researchContent: "Old claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const second = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath,
    annotationId: "companion-update",
    researchContent: "Updated claim [1]\n\n## Sources\n1. [B](<https://b.com>)\n   Retrieved: now",
    storedResearchPath: first.companionPath,
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.action, "updated");
  assert.equal(second.companionPath, first.companionPath);
  assert.match(vault.files.get(second.companionPath)!, /Updated claim/);
});

test("writeAppleAnnotationCompanion returns unchanged when content matches", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("companion-unchanged");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["companion-unchanged"]!.notePath;
  const content = "Same claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now";

  const first = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "companion-unchanged", researchContent: content,
  });
  assert.equal(first.ok && first.action, "created");

  const second = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "companion-unchanged", researchContent: content,
    storedResearchPath: first.ok ? first.companionPath : undefined,
  });
  assert.equal(second.ok && second.action, "unchanged");
});

test("annotation body remains only blockquote/user suffix after companion research", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("body-check");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["body-check"]!.notePath;
  vault.files.set(notePath, vault.files.get(notePath)! + "\nUser suffix.\n");

  await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "body-check",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });

  const noteText = vault.files.get(notePath)!;
  assert.equal(noteText.includes("mindmap:research:start"), false, "no inline research markers");
  assert.match(noteText, /^> One two three/m, "blockquote present");
  assert.match(noteText, /User suffix/);
});

test("manual Apple status applied exactly once via completeAppleAnnotationResearchForNote", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("manual-status");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["manual-status"]!.notePath;

  await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "manual-status",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });

  const statusResult = await completeAppleAnnotationResearchForNote(vault, state, notePath);
  assert.equal(statusResult, "updated");
  assert.equal(state.current.annotations["manual-status"]!.researchStatus, "complete");
  assert.match(vault.files.get(notePath)!, /research_status: complete/);

  const duplicate = await completeAppleAnnotationResearchForNote(vault, state, notePath);
  assert.equal(duplicate, "updated");
});

test("state researchPath round-trips through parseReadingState and omits invalid paths", () => {
  const raw = {
    version: READING_STATE_VERSION,
    lastSyncAt: null,
    annotations: {
      "id-valid": {
        contentHash: "abc",
        notePath: "Books/Apple Books/Author/Book/Annotations/Note.md",
        importedAt: "2026-08-01T00:00:00Z",
        researchStatus: "off",
        processedAt: null,
        researchPath: "Books/Apple Books/Author/Book/Research/Note.md",
      },
      "id-invalid-path": {
        contentHash: "def",
        notePath: "Books/Apple Books/Author/Book/Annotations/Other.md",
        importedAt: "2026-08-01T00:00:00Z",
        researchStatus: "off",
        processedAt: null,
        researchPath: "../../../etc/passwd.md",
      },
      "id-no-research-folder": {
        contentHash: "ghi",
        notePath: "Books/Apple Books/Author/Book/Annotations/Third.md",
        importedAt: "2026-08-01T00:00:00Z",
        researchStatus: "off",
        processedAt: null,
        researchPath: "Books/Apple Books/Author/Book/Annotations/Third.md",
      },
      "id-missing": {
        contentHash: "jkl",
        notePath: "Books/Apple Books/Author/Book/Annotations/Fourth.md",
        importedAt: "2026-08-01T00:00:00Z",
        researchStatus: "off",
        processedAt: null,
      },
    },
  };
  const parsed = parseReadingState(raw);
  assert.equal(parsed.annotations["id-valid"]!.researchPath, "Books/Apple Books/Author/Book/Research/Note.md");
  assert.equal(parsed.annotations["id-invalid-path"]!.researchPath, undefined);
  assert.equal(parsed.annotations["id-no-research-folder"]!.researchPath, undefined);
  assert.equal(parsed.annotations["id-missing"]!.researchPath, undefined);
});

test("state v1 without researchPath loads without data loss", () => {
  const raw = {
    version: READING_STATE_VERSION,
    lastSyncAt: "2026-08-17T00:00:00Z",
    annotations: {
      "id-1": {
        contentHash: "abc",
        notePath: "Books/Apple Books/Author/Book/Annotations/Note.md",
        importedAt: "2026-08-01T00:00:00Z",
        researchStatus: "complete",
        processedAt: null,
      },
    },
  };
  const parsed = parseReadingState(raw);
  assert.equal(parsed.annotations["id-1"]!.researchStatus, "complete");
  assert.equal(parsed.annotations["id-1"]!.researchPath, undefined);
  assert.equal(parsed.lastSyncAt, "2026-08-17T00:00:00Z");
});

test("source change removes research property but retains researchPath for reuse", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("source-change");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["source-change"]!.notePath;

  await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "source-change",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  await completeAppleAnnotationResearchForNote(vault, state, notePath);
  const companionPath = state.current.annotations["source-change"]!.researchPath!;
  assert.ok(companionPath);

  await runImport(vault, state, [annotation("source-change", { quote: "Changed quote one two three four five six seven eight nine" })]);

  const noteText = vault.files.get(notePath)!;
  assert.doesNotMatch(noteText, /^research:/m, "research property removed");
  assert.match(noteText, /research_status: off/);
  assert.equal(state.current.annotations["source-change"]!.researchStatus, "off");
  assert.equal(state.current.annotations["source-change"]!.researchPath, companionPath, "researchPath retained");
  assert.ok(vault.files.has(companionPath), "companion not deleted");
});

test("companion reuse after source change and fresh research", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("reuse");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["reuse"]!.notePath;

  await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "reuse",
    researchContent: "Old [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  const oldPath = state.current.annotations["reuse"]!.researchPath!;

  await runImport(vault, state, [annotation("reuse", { quote: "Changed quote one two three four five six seven eight nine" })]);

  const result = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "reuse",
    researchContent: "New [1]\n\n## Sources\n1. [B](<https://b.com>)\n   Retrieved: now",
    storedResearchPath: state.current.annotations["reuse"]!.researchPath,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.companionPath, oldPath, "reuses same path");
  assert.match(vault.files.get(oldPath)!, /New \[1\]/);
});

test("legacy inline LF migration creates companion, adds property, removes block", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-lf");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["legacy-lf"]!.notePath;
  const noteText = vault.files.get(notePath)!;
  vault.files.set(notePath, `${noteText}\n${RESEARCH_START}\n## Research\nSynthesis [1]\n\n### Sources\n1. [A](<https://a.com>)\n   Retrieved: now\n${RESEARCH_END}\n`);

  const result = await runImport(vault, state, [source]);

  assert.equal(result.failures.length, 0);
  const migrated = vault.files.get(notePath)!;
  assert.equal(migrated.includes(RESEARCH_START), false, "inline block removed");
  assert.match(migrated, /^research:/m, "research property added");
  const companionPath = state.current.annotations["legacy-lf"]!.researchPath!;
  assert.ok(companionPath);
  assert.ok(vault.files.has(companionPath));
  assert.match(vault.files.get(companionPath)!, /Synthesis \[1\]/);
});

test("legacy inline CRLF migration preserves CRLF outside the block", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-crlf");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["legacy-crlf"]!.notePath;
  const noteText = vault.files.get(notePath)!;
  const crlfBody = noteText.replace(/\n/g, "\r\n");
  vault.files.set(notePath, `${crlfBody}\r\n${RESEARCH_START}\r\n## Research\r\nCRLF claim [1]\r\n\r\n### Sources\r\n1. [A](<https://a.com>)\r\n   Retrieved: now\r\n${RESEARCH_END}\r\n`);

  const result = await runImport(vault, state, [source]);

  assert.equal(result.failures.length, 0);
  const migrated = vault.files.get(notePath)!;
  assert.equal(migrated.includes(RESEARCH_START), false);
  const companionPath = state.current.annotations["legacy-crlf"]!.researchPath!;
  assert.ok(vault.files.has(companionPath));
  assert.match(vault.files.get(companionPath)!, /CRLF claim \[1\]/);
});

test("legacy migration during rename uses final post-rename path for companion", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-rename");
  const legacyPath = seedLegacyAnnotation(vault, state, source);
  const legacyText = vault.files.get(legacyPath)!;
  vault.files.set(legacyPath, `${legacyText}\n${RESEARCH_START}\n## Research\nRename claim [1]\n\n### Sources\n1. [A](<https://a.com>)\n   Retrieved: now\n${RESEARCH_END}\n`);

  const result = await runImport(vault, state, [source]);
  const expectedPath = readablePath(source);

  assert.equal(result.failures.length, 0);
  assert.equal(result.imported[0]?.notePath, expectedPath);
  const companionPath = state.current.annotations["legacy-rename"]!.researchPath!;
  assert.ok(companionPath);
  assert.ok(companionPath.startsWith("Books/Apple Books/Author/The Book/Research/"));
});

test("malformed legacy markers refuse before rename or annotation modification", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-malformed");
  const legacyPath = seedLegacyAnnotation(vault, state, source);
  const legacyText = vault.files.get(legacyPath)!;
  vault.files.set(legacyPath, `${legacyText}\n${RESEARCH_START}\nresearch without end marker\n`);

  const result = await runImport(vault, state, [source]);

  assert.equal(result.failures.some((f) => f.annotationId === "legacy-malformed" && f.stage === "note"), true);
  assert.equal(vault.files.has(legacyPath), true, "file not renamed/modified");
  assert.equal(state.current.annotations["legacy-malformed"]!.notePath, legacyPath, "state unchanged");
});

test("companion write failure returns typed failure and companion remains adoptable on retry", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("companion-fail");
  await runImport(vault, state, [source]);

  const result = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: "invalid/path.md",
    annotationId: "companion-fail",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.code);
  assert.ok(result.message);
});

test("state save failure after companion write returns failure; retry adopts companion", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("state-fail-adopt");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["state-fail-adopt"]!.notePath;

  state.failNextSave = true;
  const first = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "state-fail-adopt",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  assert.equal(first.ok, false);
  if (first.ok) return;
  assert.equal(first.code, "STATE_SAVE_FAILED");
  assert.equal(state.current.annotations["state-fail-adopt"]!.researchPath, undefined);
  assert.match(vault.files.get(notePath)!, /^research:/m, "property written despite state failure");

  const companionFiles = [...vault.files.keys()].filter((p) => p.includes("/Research/"));
  assert.equal(companionFiles.length, 1, "companion written");

  const retry = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "state-fail-adopt",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.equal(retry.action, "unchanged");
  assert.equal(state.current.annotations["state-fail-adopt"]!.researchPath, retry.companionPath);
});

test("durable adoption on next sync when state save failed after companion write", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("durable-adopt");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["durable-adopt"]!.notePath;

  state.failNextSave = true;
  await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "durable-adopt",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  assert.equal(state.current.annotations["durable-adopt"]!.researchPath, undefined);

  await runImport(vault, state, [source]);
  assert.ok(state.current.annotations["durable-adopt"]!.researchPath, "researchPath adopted on next sync");
});

test("ordinary notes never create companion via writeAppleAnnotationCompanion", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  await vault.create("Notes/ordinary.md", "---\ntype: note\n---\nOrdinary note.\n");

  const result = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: "Notes/ordinary.md",
    annotationId: "ordinary-id",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });

  assert.equal(result.ok, false, "rejects non-Reading annotation path");
  assert.equal(result.ok === false && result.code, "ANNOTATION_UNTRACKED");
  const companionFiles = [...vault.files.keys()].filter((p) => p.includes("/Research/"));
  assert.equal(companionFiles.length, 0);
});

// --- Fix 1: isValidResearchPathForNote ---

test("isValidResearchPathForNote rejects other-book research paths", () => {
  const notePath = "Books/Apple Books/Author A/Book A/Annotations/Note.md";
  assert.equal(isValidResearchPathForNote("Books/Apple Books/Author B/Book B/Research/Note.md", notePath), false);
  assert.equal(isValidResearchPathForNote("Books/Apple Books/Author A/Book B/Research/Note.md", notePath), false);
  assert.equal(isValidResearchPathForNote("Books/Apple Books/Author A/Book A/Research/Note.md", notePath), true);
});

test("isValidResearchPathForNote rejects nested Research paths", () => {
  const notePath = "Books/Apple Books/Author/Book/Annotations/Note.md";
  assert.equal(isValidResearchPathForNote("Books/Apple Books/Author/Book/Research/sub/Note.md", notePath), false);
});

test("isValidResearchPathForNote rejects paths with delimiter/control characters", () => {
  const notePath = "Books/Apple Books/Author/Book/Annotations/Note.md";
  assert.equal(isValidResearchPathForNote("Books/Apple Books/Author/Book/Research/Note[1].md", notePath), false);
  assert.equal(isValidResearchPathForNote("Books/Apple Books/Author/Book/Research/Note|R.md", notePath), false);
  assert.equal(isValidResearchPathForNote("Books/Apple Books/Author/Book/Research/Note]].md", notePath), false);
});

test("isValidResearchPathForNote accepts valid collision-path variants", () => {
  const notePath = "Books/Apple Books/Author/Book/Annotations/Note.md";
  assert.equal(isValidResearchPathForNote("Books/Apple Books/Author/Book/Research/Note.md", notePath), true);
  assert.equal(isValidResearchPathForNote("Books/Apple Books/Author/Book/Research/Note · 2.md", notePath), true);
  assert.equal(isValidResearchPathForNote("Books/Apple Books/Author/Book/Research/Note · 3.md", notePath), true);
});

test("parseReadingState rejects researchPath under wrong book folder", () => {
  const raw = {
    version: READING_STATE_VERSION,
    lastSyncAt: null,
    annotations: {
      "id-1": {
        contentHash: "abc",
        notePath: "Books/Apple Books/Author A/Book A/Annotations/Note.md",
        importedAt: "2026-08-01T00:00:00Z",
        researchStatus: "off",
        processedAt: null,
        researchPath: "Books/Apple Books/Author B/Book B/Research/Note.md",
      },
    },
  };
  const parsed = parseReadingState(raw);
  assert.equal(parsed.annotations["id-1"]!.researchPath, undefined);
});

// --- Fix 2: writeAppleAnnotationCompanion pre-validation ---

test("writeAppleAnnotationCompanion rejects untracked annotationId", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  await runImport(vault, state, [annotation("tracked")]);
  const result = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: "Books/Apple Books/Author/The Book/Annotations/some.md",
    annotationId: "not-tracked",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "ANNOTATION_UNTRACKED");
  assert.equal([...vault.files.keys()].filter((p) => p.includes("/Research/")).length, 0, "no companion created");
});

test("writeAppleAnnotationCompanion rejects mismatched annotationPath", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  await runImport(vault, state, [annotation("mismatch")]);
  const result = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: "Books/Apple Books/Author/The Book/Annotations/wrong.md",
    annotationId: "mismatch",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "PATH_MISMATCH");
});

test("writeAppleAnnotationCompanion rejects frontmatter annotation_id mismatch", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  await runImport(vault, state, [annotation("fm-mismatch")]);
  const notePath = state.current.annotations["fm-mismatch"]!.notePath;
  const noteText = vault.files.get(notePath)!;
  vault.files.set(notePath, noteText.replace("fm-mismatch", "different-id"));
  const result = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath,
    annotationId: "fm-mismatch",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "ANNOTATION_ID_MISMATCH");
});

test("writeAppleAnnotationCompanion state mutate detects stale entry", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  await runImport(vault, state, [annotation("stale-entry")]);
  const notePath = state.current.annotations["stale-entry"]!.notePath;
  const originalMutate = state.mutate.bind(state);
  let mutateCount = 0;
  state.mutate = async <T>(fn: (s: ReadingState) => T | Promise<T>) => {
    mutateCount++;
    if (mutateCount === 1) {
      return await originalMutate(async (s: ReadingState) => {
        delete s.annotations["stale-entry"];
        return await fn(s);
      });
    }
    return await originalMutate(fn);
  };
  const result = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath,
    annotationId: "stale-entry",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "STATE_ENTRY_STALE");
});

// --- Fix 3: legacy migration ordering tests ---

test("legacy migration: companion-create failure leaves inline block intact", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-fail-companion");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["legacy-fail-companion"]!.notePath;
  const noteText = vault.files.get(notePath)!;
  vault.files.set(notePath, `${noteText}\n${RESEARCH_START}\n## Research\nClaim [1]\n\n### Sources\n1. [A](<https://a.com>)\n   Retrieved: now\n${RESEARCH_END}\n`);

  const researchFolder = notePath.replace(/\/Annotations\/.*$/, "/Research");
  vault.files.set(`${researchFolder}/placeholder`, "occupied");
  vault.failCreatePath = `${researchFolder}/${notePath.split("/").pop()!}`;

  const result = await runImport(vault, state, [source]);

  assert.equal(result.failures.some((f) => f.annotationId === "legacy-fail-companion" && f.stage === "note"), true);
  const finalText = vault.files.get(notePath)!;
  assert.ok(finalText.includes(RESEARCH_START), "inline block still intact");
  assert.ok(finalText.includes(RESEARCH_END), "inline end marker intact");
  assert.ok(finalText.includes("Claim [1]"), "research content preserved");
});

test("legacy migration: annotation-modify failure after companion success still preserves research in companion", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("legacy-modify-fail");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["legacy-modify-fail"]!.notePath;
  const noteText = vault.files.get(notePath)!;
  vault.files.set(notePath, `${noteText}\n${RESEARCH_START}\n## Research\nPreserved claim [1]\n\n### Sources\n1. [A](<https://a.com>)\n   Retrieved: now\n${RESEARCH_END}\n`);

  const originalModify = vault.modify.bind(vault);
  vault.modify = async (entry: VaultEntry, content: string) => {
    if (entry.path === notePath) {
      throw new Error("modify failed");
    }
    return await originalModify(entry, content);
  };

  const result = await runImport(vault, state, [source]);

  assert.equal(result.failures.some((f) => f.annotationId === "legacy-modify-fail" && f.stage === "note"), true);
  const companionFiles = [...vault.files.keys()].filter((p) => p.includes("/Research/"));
  assert.equal(companionFiles.length, 1, "companion was created before modify failed");
  assert.match(vault.files.get(companionFiles[0]!)!, /Preserved claim \[1\]/);
});

// --- Fix 4: reconcile research property from stored researchPath ---

test("unchanged source reconciles missing research property from valid stored researchPath", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("reconcile-prop");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["reconcile-prop"]!.notePath;

  await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "reconcile-prop",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  const companionPath = state.current.annotations["reconcile-prop"]!.researchPath!;
  assert.ok(companionPath);

  const noteText = vault.files.get(notePath)!;
  const stripped = noteText.split("\n").filter((l: string) => !/^research:/.test(l)).join("\n");
  vault.files.set(notePath, stripped);
  assert.doesNotMatch(vault.files.get(notePath)!, /^research:/m, "property removed");

  await runImport(vault, state, [source]);

  assert.match(vault.files.get(notePath)!, /^research:/m, "property reconciled");
  assert.match(vault.files.get(notePath)!, /Research\]\]/);
});

test("unchanged source with valid research property remains no-op", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("noop-link");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["noop-link"]!.notePath;

  await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "noop-link",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });

  vault.modified.length = 0;
  await runImport(vault, state, [source]);
  assert.equal(vault.modified.filter((p) => p === notePath).length, 0, "note not modified when link already correct");
});

test("source change removes research property but companion and researchPath survive for reuse", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("change-unlink");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["change-unlink"]!.notePath;

  await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "change-unlink",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  const companionPath = state.current.annotations["change-unlink"]!.researchPath!;

  await runImport(vault, state, [annotation("change-unlink", { quote: "New quote one two three four five six seven eight" })]);

  assert.doesNotMatch(vault.files.get(notePath)!, /^research:/m, "link removed");
  assert.equal(state.current.annotations["change-unlink"]!.researchPath, companionPath, "researchPath retained");
  assert.ok(vault.files.has(companionPath), "companion preserved");
});

// --- Fix 5: classifyResearchTarget ---

test("classifyResearchTarget returns companion for tracked annotations with correct type", () => {
  assert.equal(classifyResearchTarget("---\ntype: apple-books-annotation\n---\nbody", "tracked-id"), "companion");
});

test("classifyResearchTarget returns type-mismatch for tracked ID with wrong/missing type", () => {
  assert.equal(classifyResearchTarget("---\ntype: note\n---\nbody", "tracked-id"), "type-mismatch");
  assert.equal(classifyResearchTarget("no frontmatter", "tracked-id"), "type-mismatch");
  assert.equal(classifyResearchTarget("---\nfoo: bar\n---\nbody", "tracked-id"), "type-mismatch");
});

test("classifyResearchTarget returns inline for ordinary notes", () => {
  assert.equal(classifyResearchTarget("---\ntype: note\n---\nbody", undefined), "inline");
  assert.equal(classifyResearchTarget("no frontmatter", undefined), "inline");
});

test("classifyResearchTarget returns reading-state-missing for untracked apple annotations", () => {
  assert.equal(classifyResearchTarget("---\ntype: apple-books-annotation\n---\nbody", undefined), "reading-state-missing");
});

// --- Fix 6: status sequencing ---

test("manual research companion then one completeAppleAnnotationResearchForNote transition", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("manual-seq");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["manual-seq"]!.notePath;
  assert.equal(state.current.annotations["manual-seq"]!.researchStatus, "off");

  await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "manual-seq",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  assert.equal(state.current.annotations["manual-seq"]!.researchStatus, "off", "companion write does not change status");

  const first = await completeAppleAnnotationResearchForNote(vault, state, notePath);
  assert.equal(first, "updated");
  assert.equal(state.current.annotations["manual-seq"]!.researchStatus, "complete");

  const second = await completeAppleAnnotationResearchForNote(vault, state, notePath);
  assert.equal(second, "updated");
  assert.equal(state.current.annotations["manual-seq"]!.researchStatus, "complete");
});

test("automatic research companion then one persistAutomaticResearchOutcome transition", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("auto-seq");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["auto-seq"]!.notePath;

  await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "auto-seq",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  assert.equal(state.current.annotations["auto-seq"]!.researchStatus, "off");

  await persistAutomaticResearchOutcome({
    outcome: { ok: true },
    updateStatus: async (status) => await updateAppleAnnotationResearchStatus(vault, state, "auto-seq", status),
  });
  assert.equal(state.current.annotations["auto-seq"]!.researchStatus, "complete");
});

// --- Validation guards regressions ---

test("isValidResearchPathForNote rejects when notePath is not six-part Annotations shape", () => {
  assert.equal(isValidResearchPathForNote(
    "Books/Apple Books/Author/Book/Research/Note.md",
    "Books/Apple Books/Author/Book/Note.md",
  ), false, "notePath missing Annotations folder");
  assert.equal(isValidResearchPathForNote(
    "Books/Apple Books/Author/Book/Research/Note.md",
    "Books/Apple Books/Author/Book/Annotations/sub/Note.md",
  ), false, "notePath is nested in Annotations");
  assert.equal(isValidResearchPathForNote(
    "Books/Apple Books/Author/Book/Research/Index.md",
    "Books/Apple Books/Author/Book/Index.md",
  ), false, "notePath is an index note");
});

test("writeAppleAnnotationCompanion rejects note with wrong frontmatter type", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("type-guard");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["type-guard"]!.notePath;
  const noteText = vault.files.get(notePath)!;
  vault.files.set(notePath, noteText.replace("apple-books-annotation", "note"));
  const result = await writeAppleAnnotationCompanion(vault, state, {
    annotationPath: notePath, annotationId: "type-guard",
    researchContent: "Claim [1]\n\n## Sources\n1. [A](<https://a.com>)\n   Retrieved: now",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "TYPE_MISMATCH");
  assert.equal([...vault.files.keys()].filter((p) => p.includes("/Research/")).length, 0, "no companion created");
});

test("updateAppleAnnotationResearchStatus rejects note with wrong frontmatter type", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("status-type-guard");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["status-type-guard"]!.notePath;
  const noteText = vault.files.get(notePath)!;
  vault.files.set(notePath, noteText.replace("apple-books-annotation", "note"));
  const result = await updateAppleAnnotationResearchStatus(vault, state, "status-type-guard", "complete");
  assert.equal(result, false, "status not applied to wrong type");
  assert.equal(state.current.annotations["status-type-guard"]!.researchStatus, "off");
});

test("completeAppleAnnotationResearchForNote rejects note with wrong frontmatter type", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("complete-type-guard");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["complete-type-guard"]!.notePath;
  const noteText = vault.files.get(notePath)!;
  vault.files.set(notePath, noteText.replace("apple-books-annotation", "note"));
  const result = await completeAppleAnnotationResearchForNote(vault, state, notePath);
  assert.equal(result, false);
});

test("fast-path adoption ignores unsafe research property and never reads companion", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("unsafe-adopt");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["unsafe-adopt"]!.notePath;
  const noteText = vault.files.get(notePath)!;
  vault.files.set(notePath, noteText.replace(/---\n$/, 'research: "[[../../../etc/passwd|Research]]"\n---\n'));

  const originalRead = vault.read.bind(vault);
  const readPaths: string[] = [];
  vault.read = async (entry: VaultEntry) => {
    readPaths.push(entry.path);
    return await originalRead(entry);
  };

  await runImport(vault, state, [source]);

  assert.equal(state.current.annotations["unsafe-adopt"]!.researchPath, undefined, "unsafe path not adopted");
  assert.equal(readPaths.some((p) => p.includes("etc/passwd")), false, "never read unsafe companion");
});

test("fast-path adoption ignores other-book research property", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("other-book-adopt");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["other-book-adopt"]!.notePath;
  const noteText = vault.files.get(notePath)!;
  vault.files.set(notePath, noteText.replace(/---\n$/, 'research: "[[Books/Apple Books/Other Author/Other Book/Research/Note|Research]]"\n---\n'));
  const otherCompanionPath = "Books/Apple Books/Other Author/Other Book/Research/Note.md";
  await vault.create(otherCompanionPath, "---\ntype: mindmap-reading-research\nannotation_id: other-book-adopt\n---\nContent\n");

  await runImport(vault, state, [source]);

  assert.equal(state.current.annotations["other-book-adopt"]!.researchPath, undefined, "other-book path not adopted");
});

test("fast-path adoption ignores nested Research path in property", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("nested-adopt");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["nested-adopt"]!.notePath;
  const noteText = vault.files.get(notePath)!;
  vault.files.set(notePath, noteText.replace(/---\n$/, 'research: "[[Books/Apple Books/Author/The Book/Research/sub/Note|Research]]"\n---\n'));

  await runImport(vault, state, [source]);

  assert.equal(state.current.annotations["nested-adopt"]!.researchPath, undefined, "nested path not adopted");
});

test("reconciliation skips effectiveResearchPath that fails validation against current notePath", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("recon-invalid");
  await runImport(vault, state, [source]);
  const notePath = state.current.annotations["recon-invalid"]!.notePath;

  state.current.annotations["recon-invalid"]!.researchPath = "Books/Apple Books/Other/Other/Research/Note.md";

  const originalRead = vault.read.bind(vault);
  const readPaths: string[] = [];
  vault.read = async (entry: VaultEntry) => {
    readPaths.push(entry.path);
    return await originalRead(entry);
  };

  await runImport(vault, state, [source]);

  assert.equal(readPaths.some((p) => p.includes("Other/Other/Research")), false, "never read invalid companion");
  assert.doesNotMatch(vault.files.get(notePath)!, /^research:/m, "no research property added");
});
