import test from "node:test";
import assert from "node:assert/strict";

import {
  completeAppleAnnotationResearchForNote,
  importAppleBooksAnnotations,
  renderAnnotationNote,
  updateAppleAnnotationResearchStatus,
  type AnnotationImportResult,
} from "./appleBooksImport";
import type { ReadingStateStore } from "./readingState";
import { selectAutomaticResearchCandidates } from "./automaticResearch";
import {
  annotationContentHash,
  annotationPathCandidate,
  baseAnnotationNotePath,
  createEmptyReadingState,
  READING_INDEX_END,
  READING_INDEX_START,
  READING_SOURCE_END,
  READING_SOURCE_START,
  type AppleBooksAnnotation,
  type AppleBooksReaderPayload,
  type ReadingState,
} from "./readingTypes";
import { deriveHumanTitle, humanTitleCandidate } from "./readingNoteFormat";
import type { ReadingVault, VaultEntry } from "./readingVault";

class MemoryVault implements ReadingVault {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  readonly modified: string[] = [];
  failCreatePath: string | null = null;
  failRenamePath: string | null = null;
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
  failSave = false;
  failNextSave = false;

  async load(): Promise<ReadingState> {
    return cloneState(this.current);
  }

  async save(state: ReadingState): Promise<void> {
    if (this.failSave || this.failNextSave) {
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
  vault.files.set(notePath, `${vault.files.get(notePath)}\nUser body.\n<!-- mindmap:research:start -->\nResearch stays.\n<!-- mindmap:research:end -->\n`);
  const modificationsBeforeDuplicate = vault.modified.length;

  const duplicate = await runImport(vault, state, [annotation("id-1")]);
  assert.equal(duplicate.imported[0]?.action, "unchanged");
  assert.equal(vault.modified.length, modificationsBeforeDuplicate);

  const modificationsBeforeEdit = vault.modified.length;
  const edited = await runImport(vault, state, [annotation("id-1", { quote: "Changed quote one two three four five six seven eight nine" })]);
  const editedText = vault.files.get(notePath) ?? "";
  assert.equal(edited.imported[0]?.action, "updated");
  assert.match(editedText, /Changed quote/);
  assert.doesNotMatch(editedText, /One two three/);
  assert.match(editedText, /User body/);
  assert.match(editedText, /Research stays/);
  assert.equal(vault.modified.length, modificationsBeforeEdit + 1);
  assert.equal(vault.modified[vault.modified.length - 1], notePath);
});

test("ten annotation import cycles keep one stable note and preserve state and research content", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const initial = annotation("ten-cycle");
  const first = await runImport(vault, state, [initial]);
  const notePath = first.imported[0]!.notePath;
  vault.files.set(notePath, `${vault.files.get(notePath)}\nUser detail.\n<!-- mindmap:research:start -->\nStable research. [1]\n<!-- mindmap:research:end -->\n`);

  for (let cycle = 0; cycle < 10; cycle += 1) {
    const source = annotation("ten-cycle", { quote: cycle % 2 === 0 ? initial.quote : `Cycle ${cycle} quote one two three four five six seven eight nine` });
    await runImport(vault, state, [source], `2026-08-17T0${cycle}:00:00Z`);
    const annotationPaths = [...vault.files.keys()].filter((candidate) => candidate.includes("/Annotations/") && candidate.endsWith(".md"));
    assert.deepEqual(annotationPaths, [notePath]);
    assert.equal(state.current.annotations["ten-cycle"]?.notePath, notePath);
    assert.match(vault.files.get(notePath) ?? "", /Stable research\. \[1\]/);
    assert.match(vault.files.get(notePath) ?? "", /User detail\./);
  }
});

test("changed source preserves the existing research block but resets note and state research status", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const first = await runImport(vault, state, [annotation("changed-research")]);
  const notePath = first.imported[0]!.notePath;
  vault.files.set(notePath, `${vault.files.get(notePath)}\n<!-- mindmap:research:start -->\nOld valid research. [1]\n<!-- mindmap:research:end -->\n`);
  await updateAppleAnnotationResearchStatus(vault, state, "changed-research", "complete");

  await runImport(vault, state, [annotation("changed-research", { quote: "Changed quote one two three four five six seven eight nine" })]);
  const changed = vault.files.get(notePath) ?? "";
  assert.match(changed, /Old valid research\. \[1\]/);
  assert.match(changed, /research_status: off/);
  assert.equal(state.current.annotations["changed-research"]!.researchStatus, "off");
  assert.equal(state.current.annotations["changed-research"]!.processedAt, null);
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
