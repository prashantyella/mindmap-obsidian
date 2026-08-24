import test from "node:test";
import assert from "node:assert/strict";
import type { Vault, Workspace } from "obsidian";

import { canonicalizePath, stableNoteIdentity, type MetadataOutputV1 } from "./contracts";
import { isEngineError } from "./errors";
import { NoteWriter } from "./noteWriter";
import { projectSource } from "./sourceProjection";
import {
  createDeferredScopeImportSeam,
  createProductionNoteReplacementSeam,
  createProductionNoteSourceReader,
  createProductionNoteVaultAdapter,
  createProductionScopeDiscoverySeam,
  createProductionScopeEnqueueSeam,
  openRelatedNote,
} from "./productionVaultAdapter";

interface FakeTFile {
  path: string;
  extension: string;
  stat: { size: number; mtime: number; ctime: number };
}

interface FakeTFolder {
  path: string;
  children: unknown[];
}

/** Structurally shaped exactly like `productionVaultAdapter.ts`'s own `isTFileLike`/`isTFolderLike` expect -- a `TFile` carries `extension`/`stat` and no `children`; a `TFolder` carries a `children` array. */
function fakeVault(files: Record<string, string>, configDir = ".obsidian"): { vault: Vault; files: Record<string, string> } {
  const folders = new Set<string>();
  const toFile = (filePath: string): FakeTFile => ({ path: filePath, extension: filePath.split(".").pop() ?? "", stat: { size: 0, mtime: 0, ctime: 0 } });
  const toFolder = (folderPath: string): FakeTFolder => ({ path: folderPath, children: [] });

  const vault = {
    configDir,
    getMarkdownFiles: () => Object.keys(files).filter((p) => p.endsWith(".md")).map(toFile) as never,
    getAbstractFileByPath: (relpath: string): unknown => {
      if (Object.prototype.hasOwnProperty.call(files, relpath)) return toFile(relpath);
      if (folders.has(relpath)) return toFolder(relpath);
      return null;
    },
    read: async (file: FakeTFile) => {
      if (!Object.prototype.hasOwnProperty.call(files, file.path)) throw new Error("ENOENT");
      return files[file.path];
    },
    cachedRead: async (file: FakeTFile) => {
      if (!Object.prototype.hasOwnProperty.call(files, file.path)) throw new Error("ENOENT");
      return files[file.path];
    },
    modify: async (file: FakeTFile, content: string) => {
      if (!Object.prototype.hasOwnProperty.call(files, file.path)) throw new Error("ENOENT");
      files[file.path] = content;
    },
    createFolder: async (folderPath: string) => {
      if (folders.has(folderPath)) throw new Error("folder already exists");
      folders.add(folderPath);
      return toFolder(folderPath);
    },
    create: async (relpath: string, content: string) => {
      if (Object.prototype.hasOwnProperty.call(files, relpath)) throw new Error("file already exists");
      files[relpath] = content;
      return toFile(relpath);
    },
  } as unknown as Vault;
  return { vault, files };
}

const LONG_NOTE = "word ".repeat(40).trim();

void test("createProductionNoteVaultAdapter.read: returns content for an existing path, null for a missing one", async () => {
  const { vault } = fakeVault({ "Notes/a.md": "hello" });
  const adapter = createProductionNoteVaultAdapter(vault);
  assert.equal(await adapter.read("Notes/a.md"), "hello");
  assert.equal(await adapter.read("Notes/missing.md"), null);
});

void test("createProductionNoteVaultAdapter.modify overwrites an existing path via vault.modify (never vault.adapter.write) -- so Obsidian's cache/events fire", async () => {
  const { vault, files } = fakeVault({ "Notes/a.md": "old" });
  const modifyCalls: unknown[] = [];
  (vault as unknown as { modify: (file: unknown, content: string) => Promise<void> }).modify = async (file: unknown, content: string) => {
    modifyCalls.push(file);
    files[(file as { path: string }).path] = content;
  };
  const adapter = createProductionNoteVaultAdapter(vault);
  await adapter.modify("Notes/a.md", "new");
  assert.equal(files["Notes/a.md"], "new");
  assert.equal(modifyCalls.length, 1, "modify must go through vault.modify(TFile, content), never vault.adapter.write");
});

void test("createProductionNoteVaultAdapter.modify throws a closed, retryable VAULT_WRITE_FAILED when the path no longer resolves to a file (never silently creates one)", async () => {
  const { vault } = fakeVault({});
  const adapter = createProductionNoteVaultAdapter(vault);
  await assert.rejects(() => adapter.modify("Notes/gone.md", "new"), (error: unknown) => isEngineError(error) && error.code === "VAULT_WRITE_FAILED");
});

void test("createProductionNoteVaultAdapter.read throws a closed, retryable VAULT_READ_FAILED when a resolved TFile's own read throws (a real I/O failure, never downgraded to null)", async () => {
  const { vault } = fakeVault({ "Notes/a.md": "content" });
  (vault as unknown as { read: () => Promise<string> }).read = async () => {
    throw new Error("EACCES: permission denied");
  };
  const adapter = createProductionNoteVaultAdapter(vault);
  await assert.rejects(() => adapter.read("Notes/a.md"), (error: unknown) => isEngineError(error) && error.code === "VAULT_READ_FAILED");
});

void test("createProductionNoteVaultAdapter.ensureFolder tolerates a concurrent create race -- a createFolder failure is not an error if the folder exists by the time it's re-checked", async () => {
  const { vault } = fakeVault({});
  let createFolderCalls = 0;
  (vault as unknown as { createFolder: (path: string) => Promise<unknown>; getAbstractFileByPath: (path: string) => unknown }).createFolder = async (path: string) => {
    createFolderCalls += 1;
    // Simulate: another writer wins the race and creates the folder first.
    (vault as unknown as { getAbstractFileByPath: (path: string) => unknown }).getAbstractFileByPath = (p: string) => (p === path ? { path, children: [] } : null);
    throw new Error("EEXIST");
  };
  const adapter = createProductionNoteVaultAdapter(vault);
  await assert.doesNotReject(() => adapter.ensureFolder("Notes/New"));
  assert.equal(createFolderCalls, 1);
});

void test("createProductionNoteVaultAdapter.ensureFolder throws when a NOTE (not a folder) already occupies the target path", async () => {
  const { vault } = fakeVault({ "Notes/collides": "a file, not a folder" });
  const adapter = createProductionNoteVaultAdapter(vault);
  await assert.rejects(() => adapter.ensureFolder("Notes/collides"), (error: unknown) => isEngineError(error) && error.code === "VAULT_WRITE_FAILED");
});

void test("item 5/9: NoteWriter.writeMetadata against the REAL production adapter mutates an existing note through vault.modify (never vault.adapter.write), so Obsidian's own cache/change-events fire for ordinary process-note behavior", async () => {
  const path = canonicalizePath("Notes/Example.md");
  const raw = "---\ntitle: Example\n---\nBody content with enough words to be a real note.\n";
  const { vault, files } = fakeVault({ [path]: raw });
  const modifyCalls: string[] = [];
  const originalModify = (vault as unknown as { modify: (file: unknown, content: string) => Promise<void> }).modify;
  (vault as unknown as { modify: (file: unknown, content: string) => Promise<void> }).modify = async (file: unknown, content: string) => {
    modifyCalls.push((file as { path: string }).path);
    await originalModify(file, content);
  };

  const identity = stableNoteIdentity(path);
  const expectedSourceHash = projectSource(identity, raw).sourceHash;
  const metadata: MetadataOutputV1 = { schemaVersion: 1, identity, summary: "A summary.", tags: ["alpha"], concepts: ["One"], related: [] };

  const writer = new NoteWriter(createProductionNoteVaultAdapter(vault));
  const result = await writer.writeMetadata({
    identity,
    path,
    expectedSourceHash,
    metadata,
    isAppleAnnotation: false,
    writeMindmapSection: false,
    removeMindmapSection: false,
  });

  assert.equal(result.status, "written");
  assert.equal(files[path], result.content);
  assert.deepEqual(modifyCalls, [path], "the mutation must go through vault.modify(TFile, content) exactly once, never a raw adapter.write");
});

void test("createProductionNoteVaultAdapter.create is exclusive -- rejects without writing if the path already exists", async () => {
  const { vault, files } = fakeVault({ "Notes/a.md": "existing" });
  const adapter = createProductionNoteVaultAdapter(vault);
  await assert.rejects(() => adapter.create("Notes/a.md", "new content"));
  assert.equal(files["Notes/a.md"], "existing");
});

void test("createProductionNoteVaultAdapter.create writes a brand-new path", async () => {
  const { vault, files } = fakeVault({});
  const adapter = createProductionNoteVaultAdapter(vault);
  await adapter.create("Notes/new.md", "content");
  assert.equal(files["Notes/new.md"], "content");
});

void test("createProductionNoteVaultAdapter.ensureFolder is a safe no-op for an already-existing folder and for '.'", async () => {
  const { vault } = fakeVault({ "Notes/a.md": "x" });
  const adapter = createProductionNoteVaultAdapter(vault);
  await adapter.ensureFolder(".");
  await adapter.ensureFolder("");
});

void test("createProductionNoteSourceReader resolves a path-kind identity by its exact canonical path, and returns null when the path is gone", async () => {
  const { vault } = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
  const reader = createProductionNoteSourceReader({ vault, scopeFolders: ["Notes"], minimumWords: 5 });
  const found = await reader.read({ schemaVersion: 1, kind: "path", canonicalPath: "Notes/a.md" as never });
  assert.ok(found);
  assert.equal(found?.identity.canonicalPath, "Notes/a.md");

  const missing = await reader.read({ schemaVersion: 1, kind: "path", canonicalPath: "Notes/gone.md" as never });
  assert.equal(missing, null);
});

void test("createProductionNoteSourceReader resolves an apple-annotation identity by id even after a rename to a different valid annotation path", async () => {
  const annotationText = "---\ntype: apple-books-annotation\nannotation_id: abc-123\n---\n" + "word ".repeat(10);
  const { vault } = fakeVault({ "Books/Apple Books/Author/Book/Annotations/renamed.md": annotationText });
  const reader = createProductionNoteSourceReader({ vault, scopeFolders: [], minimumWords: 5 });
  const found = await reader.read({ schemaVersion: 1, kind: "apple-annotation", canonicalPath: "Books/Apple Books/Author/Book/Annotations/old-name.md" as never, appleAnnotationId: "abc-123" });
  assert.ok(found);
  assert.equal(found?.identity.canonicalPath, "Books/Apple Books/Author/Book/Annotations/renamed.md");
});

void test("createProductionNoteSourceReader returns null for an apple-annotation identity whose id no longer exists anywhere in the vault", async () => {
  const { vault } = fakeVault({});
  const reader = createProductionNoteSourceReader({ vault, scopeFolders: [], minimumWords: 5 });
  const found = await reader.read({ schemaVersion: 1, kind: "apple-annotation", canonicalPath: "Books/Apple Books/Author/Book/Annotations/gone.md" as never, appleAnnotationId: "abc-123" });
  assert.equal(found, null);
});

void test("createProductionNoteSourceReader.read rejects immediately (before touching the vault) when passed an already-aborted signal (item 5: abort-check around every vault await)", async () => {
  const { vault } = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
  const reader = createProductionNoteSourceReader({ vault, scopeFolders: ["Notes"], minimumWords: 5 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => reader.read({ schemaVersion: 1, kind: "path", canonicalPath: "Notes/a.md" as never }, controller.signal));
});

void test("createProductionNoteSourceReader.read (item 3) honors an abort that lands DURING the vault.read await, not just before it -- rejecting rather than returning a result the caller already gave up on", async () => {
  const { vault } = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
  const controller = new AbortController();
  (vault as unknown as { read: (file: unknown) => Promise<string> }).read = async (file: unknown) => {
    controller.abort();
    return (vault as unknown as { cachedRead: (file: unknown) => Promise<string> }).cachedRead(file);
  };
  const reader = createProductionNoteSourceReader({ vault, scopeFolders: ["Notes"], minimumWords: 5 });
  await assert.rejects(() => reader.read({ schemaVersion: 1, kind: "path", canonicalPath: "Notes/a.md" as never }, controller.signal));
});

void test("createProductionNoteSourceReader throws a closed, retryable VAULT_READ_FAILED (never a silent null) when a resolved TFile's read itself fails", async () => {
  const { vault } = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
  (vault as unknown as { read: () => Promise<string> }).read = async () => {
    throw new Error("EACCES: permission denied");
  };
  const reader = createProductionNoteSourceReader({ vault, scopeFolders: ["Notes"], minimumWords: 5 });
  await assert.rejects(() => reader.read({ schemaVersion: 1, kind: "path", canonicalPath: "Notes/a.md" as never }), (error: unknown) => isEngineError(error) && error.code === "VAULT_READ_FAILED");
});

void test("createProductionScopeDiscoverySeam discovers eligible notes and computes each one's real sourceHash via projectSource", async () => {
  const { vault } = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}`, "Notes/short.md": "too short" });
  const registry = new Map([["scope-id", { scopeFolders: ["Notes"], includeReadingAnnotations: false }]]);
  const seam = createProductionScopeDiscoverySeam({ vault, minimumWords: 30 }, registry, "nomic-embed-text");
  const items = await seam.discover("scope-id", new AbortController().signal);
  assert.equal(items.length, 1);
  assert.equal(items[0].embeddingModel, "nomic-embed-text");
  assert.match(items[0].sourceHash, /^[0-9a-f]{64}$/);
});

void test("createProductionScopeDiscoverySeam (10B blocker resolution) fails closed -- an unrecognized scopeId returns zero items and reads nothing, never falling back to any other registered scope's folders", async () => {
  const reads: string[] = [];
  const { vault } = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
  const originalRead = (vault as unknown as { cachedRead: (file: unknown) => Promise<string> }).cachedRead;
  (vault as unknown as { cachedRead: (file: unknown) => Promise<string> }).cachedRead = async (file: unknown) => {
    reads.push((file as { path: string }).path);
    return originalRead(file);
  };
  const registry = new Map([["all", { scopeFolders: ["Notes"], includeReadingAnnotations: false }]]);
  const seam = createProductionScopeDiscoverySeam({ vault, minimumWords: 5 }, registry, "nomic-embed-text");
  const items = await seam.discover("unknown-scope-id", new AbortController().signal);
  assert.deepEqual(items, []);
  assert.deepEqual(reads, [], "an unrecognized scopeId must read zero files, never falling back to the 'all' entry's folders");
});

void test("createDeferredScopeImportSeam.import resolves without touching anything -- a documented no-op, never a live Apple Books call", async () => {
  const seam = createDeferredScopeImportSeam();
  await assert.doesNotReject(() => seam.import("reading-scope", [], new AbortController().signal));
});

void test("createProductionScopeEnqueueSeam forwards to the injected job submitter with the given trigger/pipelineVersion", async () => {
  const submitted: unknown[] = [];
  const fakeJobEngine = { submit: async (input: unknown) => { submitted.push(input); return input; } };
  const seam = createProductionScopeEnqueueSeam(fakeJobEngine, "reading");
  await seam.enqueueProcessNote({ identity: { schemaVersion: 1, kind: "path", canonicalPath: "Notes/a.md" as never }, sourceHash: "a".repeat(64), embeddingModel: "m" }, 3, new AbortController().signal);
  assert.deepEqual(submitted, [{ trigger: "reading", kind: "process-note", identity: { schemaVersion: 1, kind: "path", canonicalPath: "Notes/a.md" }, sourceHash: "a".repeat(64), embeddingModel: "m", pipelineVersion: 3 }]);
});

void test("createProductionNoteReplacementSeam forwards to the injected job submitter", async () => {
  const submitted: unknown[] = [];
  const fakeJobEngine = { submit: async (input: unknown) => { submitted.push(input); return input; } };
  const seam = createProductionNoteReplacementSeam(fakeJobEngine, "manual");
  await seam.enqueueReplacement({ identity: { schemaVersion: 1, kind: "path", canonicalPath: "Notes/a.md" as never }, sourceHash: "b".repeat(64), embeddingModel: "m", pipelineVersion: 2 });
  assert.deepEqual(submitted, [{ trigger: "manual", kind: "process-note", identity: { schemaVersion: 1, kind: "path", canonicalPath: "Notes/a.md" }, sourceHash: "b".repeat(64), embeddingModel: "m", pipelineVersion: 2 }]);
});

function fakeWorkspace(): { workspace: Workspace; calls: unknown[] } {
  const calls: unknown[] = [];
  const workspace = { openLinkText: async (...args: unknown[]) => { calls.push(args); } } as unknown as Workspace;
  return { workspace, calls };
}

void test("openRelatedNote opens via workspace.openLinkText and rejects an empty path before ever calling it", async () => {
  const { workspace, calls } = fakeWorkspace();
  await openRelatedNote(workspace, "Notes/related.md");
  assert.deepEqual(calls, [["Notes/related.md", "", false]]);

  await assert.rejects(() => openRelatedNote(workspace, ""), (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID");
  assert.equal(calls.length, 1, "the rejected empty-path call must never reach workspace.openLinkText");
});

void test("openRelatedNote (item 6) rejects an absolute path, a traversal path, and a control-character path -- never reaching workspace.openLinkText for any of them", async () => {
  const { workspace, calls } = fakeWorkspace();
  await assert.rejects(() => openRelatedNote(workspace, "/Secret/note.md"), (error: unknown) => isEngineError(error) && error.code === "PATH_ABSOLUTE");
  await assert.rejects(() => openRelatedNote(workspace, "Notes/../Secret/note.md"), (error: unknown) => isEngineError(error) && error.code === "PATH_TRAVERSAL");
  await assert.rejects(() => openRelatedNote(workspace, "Notes/\x01note.md"), (error: unknown) => isEngineError(error) && error.code === "PATH_CONTROL_CHARACTER");
  assert.equal(calls.length, 0);
});

void test("openRelatedNote (10B prerequisite 2) rejects a raw path that differs from its own canonicalized form, instead of silently opening the fixed-up version", async () => {
  const { workspace, calls } = fakeWorkspace();
  await assert.rejects(() => openRelatedNote(workspace, "Notes//related.md"), (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID");
  await assert.rejects(() => openRelatedNote(workspace, "Notes/./related.md"), (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID");
  assert.equal(calls.length, 0, "a noncanonical raw path must never reach workspace.openLinkText, not even at its canonicalized form");
});

void test("openRelatedNote (item 6) rejects a non-.md path", async () => {
  const { workspace, calls } = fakeWorkspace();
  await assert.rejects(() => openRelatedNote(workspace, "Notes/attachment.pdf"), (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID");
  assert.equal(calls.length, 0);
});

void test("openRelatedNote (item 6) rejects a target inside a CUSTOM (non-default) configDir, and rejects a target inside the plugin's own runtime-internal folder", async () => {
  const { workspace, calls } = fakeWorkspace();
  await assert.rejects(
    () => openRelatedNote(workspace, "MyCustomConfig/plugins/mindmap/data.md", { configDir: "MyCustomConfig" }),
    (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID",
  );
  await assert.rejects(
    () => openRelatedNote(workspace, ".obsidian/plugins/mindmap/internal.md", { runtimeFolder: ".obsidian/plugins/mindmap" }),
    (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID",
  );
  assert.equal(calls.length, 0);
});

void test("openRelatedNote (item 6) DOES open an ordinary note that merely LOOKS hidden (a dot-prefixed folder that is not the actual configDir)", async () => {
  const { workspace, calls } = fakeWorkspace();
  await openRelatedNote(workspace, ".journal/private-note.md", { configDir: ".obsidian" });
  assert.deepEqual(calls, [[".journal/private-note.md", "", false]]);
});

void test("createProductionNoteVaultAdapter (item 3) throws a STATIC, redacted VAULT_READ_FAILED/VAULT_WRITE_FAILED -- the raw caught error's own message is never attached as context/cause", async () => {
  const { vault } = fakeVault({ "Notes/a.md": "content" });
  (vault as unknown as { read: () => Promise<string> }).read = async () => {
    throw new Error("EACCES: permission denied for /Users/real-person/secret-path/Notes/a.md");
  };
  const adapter = createProductionNoteVaultAdapter(vault);
  try {
    await adapter.read("Notes/a.md");
    assert.fail("expected adapter.read to throw");
  } catch (error) {
    assert.ok(isEngineError(error) && error.code === "VAULT_READ_FAILED");
    const serialized = JSON.stringify(error);
    assert.doesNotMatch(serialized, /permission denied|real-person|secret-path/, "the raw caught error message must never leak into the thrown EngineError");
  }
});

void test("createProductionNoteVaultAdapter (item 3) uses real instanceof guards when injected TFile/TFolder classes are provided, instead of the structural fallback", async () => {
  class InjectedTFile {}
  class InjectedTFolder {}
  const realFileInstance = Object.assign(new InjectedTFile(), { path: "Notes/real.md" });
  const structurallyFileShapedButNotRealClass = { path: "Notes/fake.md", extension: "md", stat: { size: 0, mtime: 0, ctime: 0 } };
  const vault = {
    configDir: ".obsidian",
    getAbstractFileByPath: (relpath: string) => {
      if (relpath === "Notes/real.md") return realFileInstance;
      if (relpath === "Notes/fake.md") return structurallyFileShapedButNotRealClass;
      return null;
    },
    read: async (file: unknown) => {
      if (file === realFileInstance) return "real content";
      throw new Error("unexpected read target");
    },
  } as unknown as import("obsidian").Vault;
  const adapter = createProductionNoteVaultAdapter(vault, { TFile: InjectedTFile as never, TFolder: InjectedTFolder as never });
  assert.equal(await adapter.read("Notes/real.md"), "real content", "a real instanceof-matching TFile must be readable");
  assert.equal(await adapter.read("Notes/fake.md"), null, "a merely structurally-shaped object that is NOT an instance of the injected TFile class must be treated as missing, once real classes are injected");
});
