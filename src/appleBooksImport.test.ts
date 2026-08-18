import test from "node:test";
import assert from "node:assert/strict";

import {
  importAppleBooksAnnotations,
  renderAnnotationNote,
  type AnnotationImportResult,
} from "./appleBooksImport";
import type { ReadingStateStore } from "./readingState";
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
