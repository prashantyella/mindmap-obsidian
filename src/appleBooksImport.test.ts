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
  baseAnnotationNotePath,
  annotationPathCandidate,
  createEmptyReadingState,
  READING_INDEX_END,
  READING_INDEX_START,
  READING_SOURCE_END,
  READING_SOURCE_START,
  type AppleBooksAnnotation,
  type AppleBooksReaderPayload,
  type ReadingState,
} from "./readingTypes";
import type { ReadingVault, VaultEntry } from "./readingVault";

class MemoryVault implements ReadingVault {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  readonly modified: string[] = [];
  failCreatePath: string | null = null;

  get(path: string): VaultEntry | null {
    if (this.files.has(path) || this.folders.has(path)) {
      return { path, raw: path };
    }
    return null;
  }

  async read(entry: VaultEntry): Promise<string> {
    const content = this.files.get(String(entry.raw));
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

test("imports one note and one deterministic book index through the Vault abstraction", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const result = await runImport(vault, state, [annotation("id-1")]);
  const notePath = result.imported[0]?.notePath ?? "";
  const indexPath = result.indexPaths[0] ?? "";

  assert.equal(result.failures.length, 0);
  assert.equal(result.imported[0]?.action, "created");
  assert.match(notePath, /^Books\/Apple Books\/Author\/The Book\/Annotations\/2026-08-17-/);
  assert.match(vault.files.get(notePath) ?? "", /type: apple-books-annotation/);
  assert.match(vault.files.get(notePath) ?? "", /annotation_id: id-1/);
  assert.match(vault.files.get(notePath) ?? "", new RegExp(READING_SOURCE_START));
  assert.match(vault.files.get(notePath) ?? "", new RegExp(READING_SOURCE_END));
  assert.match(vault.files.get(indexPath) ?? "", new RegExp(READING_INDEX_START));
  assert.match(vault.files.get(indexPath) ?? "", new RegExp(READING_INDEX_END));
  assert.equal(state.current.annotations["id-1"]?.notePath, notePath);
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
  const expectedPath = baseAnnotationNotePath(source);
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

test("probes base and fallback occupants without modifying unrelated notes", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const source = annotation("occupied");
  const basePath = annotationPathCandidate(source, 0);
  const firstFallbackPath = annotationPathCandidate(source, 1);
  const nextPath = annotationPathCandidate(source, 2);
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

test("duplicate imports are no-ops, edits replace only the source block, and indexes stay idempotent", async () => {
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
  assert.equal((editedText.match(new RegExp(READING_SOURCE_START, "g")) ?? []).length, 1);
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

test("preserves unrelated frontmatter and marker-like annotation text safely", () => {
  const text = renderAnnotationNote(
    "---\nsummary: Keep this\ntags:\n  - user\n---\nUser content.\n",
    annotation("id-1", { quote: `Quote\n${READING_SOURCE_END}` }),
    { importedAt: "2026-08-17T01:00:00Z", researchStatus: "off" },
  );

  assert.match(text, /summary: Keep this/);
  assert.match(text, /- user/);
  assert.match(text, /User content/);
  assert.equal((text.match(new RegExp(`^${READING_SOURCE_START}$`, "gm")) ?? []).length, 1);
  assert.equal((text.match(new RegExp(`^${READING_SOURCE_END}$`, "gm")) ?? []).length, 1);
  assert.match(text, /> <!-- mindmap:apple-books-source:end -->/);
});

test("partial note failure commits prior annotations but does not advance failed state", async () => {
  const vault = new MemoryVault();
  const state = new MemoryState();
  const second = annotation("id-2");
  const expectedSecond = (await runImport(new MemoryVault(), new MemoryState(), [second])).imported[0]!.notePath;
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
