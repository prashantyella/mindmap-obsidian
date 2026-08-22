import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, stableNoteIdentity, type MetadataOutputV1 } from "./contracts";
import { isEngineError } from "./errors";
import { NoteWriter, type NoteVaultAdapter } from "./noteWriter";
import { projectSource } from "./sourceProjection";

class FakeVault implements NoteVaultAdapter {
  files = new Map<string, string>();
  folders = new Set<string>();
  writeCount = 0;
  failNextWrite = false;

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async modify(path: string, content: string): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("injected vault write failure");
    }
    this.writeCount += 1;
    this.files.set(path, content);
  }

  async create(path: string, content: string): Promise<void> {
    if (this.files.has(path)) {
      throw new Error(`already exists: ${path}`);
    }
    this.writeCount += 1;
    this.files.set(path, content);
  }

  async ensureFolder(path: string): Promise<void> {
    this.folders.add(path);
  }
}

function identityFor(pathValue: string) {
  return stableNoteIdentity(canonicalizePath(pathValue));
}

function annotationIdentityFor(pathValue: string, annotationId: string) {
  return stableNoteIdentity(canonicalizePath(pathValue), annotationId);
}

function metadataFor(overrides: Partial<MetadataOutputV1> = {}): MetadataOutputV1 {
  return {
    schemaVersion: 1,
    identity: identityFor("Notes/Example.md"),
    summary: "A summary.",
    tags: ["alpha", "beta"],
    concepts: ["One"],
    related: ["Notes/Other.md"],
    ...overrides,
  };
}

void test("writeMetadata updates managed frontmatter and Related section for an ordinary note", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Notes/Example.md");
  const raw = "---\ntitle: Example\nauthor: Jane\n---\nBody content.\n";
  vault.files.set(path, raw);
  const identity = identityFor(path);
  const expectedSourceHash = projectSource(identity, raw).sourceHash;

  const writer = new NoteWriter(vault);
  const result = await writer.writeMetadata({
    identity,
    path,
    expectedSourceHash,
    metadata: metadataFor(),
    isAppleAnnotation: false,
    relatedLinks: [{ path: canonicalizePath("Notes/Other.md"), kind: "core" }],
    writeMindmapSection: true,
    removeMindmapSection: false,
  });

  assert.equal(result.status, "written");
  assert.equal(vault.files.get(path), result.content);
  assert.match(result.content, /title: Example/);
  assert.match(result.content, /author: Jane/);
  assert.match(result.content, /summary: A summary\./);
  assert.match(result.content, /> \[!mindmap]- Mindmap/);
  assert.match(result.content, /\[\[Notes\/Other\.md\|Other]]/);
});

void test("writeMetadata clears summary/tags, renders concept/related wikilinks, and keeps the body annotation-only for Apple annotation notes", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Books/Apple Books/Author/Book/Annotations/Quote.md");
  const raw = "---\ntitle: Quote\ntype: apple-books-annotation\nsummary: stale\ntags:\n  - old\n---\n> The annotated quote.\n\nA user note.\n";
  vault.files.set(path, raw);
  const identity = annotationIdentityFor(path, "annotation-1");
  const expectedSourceHash = projectSource(identity, raw).sourceHash;

  const writer = new NoteWriter(vault);
  const result = await writer.writeMetadata({
    identity,
    path,
    expectedSourceHash,
    metadata: metadataFor({ identity, concepts: ["Idea"], related: ["Notes/Other.md"] }),
    isAppleAnnotation: true,
    writeMindmapSection: false,
    removeMindmapSection: false,
  });

  assert.equal(result.status, "written");
  assert.doesNotMatch(result.content, /^summary:/m);
  assert.doesNotMatch(result.content, /^tags:/m);
  assert.match(result.content, /concepts:\n {2}- '\[\[Idea]]'/);
  assert.match(result.content, /related:\n {2}- '\[\[Notes\/Other\|Other]]'/);
  assert.match(result.content, /> The annotated quote\.\n\nA user note\.\n$/, "annotation body must survive untouched");
  assert.doesNotMatch(result.content, /mindmap-link/, "Apple annotation notes never gain a generated Related callout");
});

void test("writeMetadata rejects a stale source (user-authored content changed since the hash was computed) and performs no write", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Notes/Example.md");
  const original = "---\ntitle: Example\n---\nOriginal body.\n";
  const identity = identityFor(path);
  const staleHash = projectSource(identity, original).sourceHash;

  vault.files.set(path, "---\ntitle: Example\n---\nUser edited the body in the meantime.\n");

  const writer = new NoteWriter(vault);
  await assert.rejects(
    () =>
      writer.writeMetadata({
        identity,
        path,
        expectedSourceHash: staleHash,
        metadata: metadataFor({ identity }),
        isAppleAnnotation: false,
        writeMindmapSection: false,
        removeMindmapSection: false,
      }),
    (error: unknown) => isEngineError(error) && error.code === "SOURCE_STALE",
  );
  assert.equal(vault.writeCount, 0);
});

void test("writeMetadata does not treat Mindmap's own prior managed-output write as stale", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Notes/Example.md");
  const raw = "---\ntitle: Example\n---\nBody.\n";
  vault.files.set(path, raw);
  const identity = identityFor(path);
  const expectedSourceHash = projectSource(identity, raw).sourceHash;

  const writer = new NoteWriter(vault);
  const options = {
    identity,
    path,
    expectedSourceHash,
    metadata: metadataFor({ identity }),
    isAppleAnnotation: false,
    relatedLinks: [{ path: canonicalizePath("Notes/Other.md"), kind: "core" as const }],
    writeMindmapSection: true,
    removeMindmapSection: false,
  };

  const first = await writer.writeMetadata(options);
  assert.equal(first.status, "written");
  // The same expectedSourceHash (computed against the ORIGINAL user content)
  // must still be valid after Mindmap's own managed-output write, because
  // managed keys/sections are excluded from sourceHash.
  const second = await writer.writeMetadata(options);
  assert.equal(second.status, "unchanged");
  assert.equal(second.content, first.content);
  assert.equal(vault.writeCount, 1, "the unchanged second write must not touch the vault");
});

void test("writeMetadata propagates a vault write failure without corrupting in-memory expectations", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Notes/Example.md");
  const raw = "---\ntitle: Example\n---\nBody.\n";
  vault.files.set(path, raw);
  const identity = identityFor(path);
  const expectedSourceHash = projectSource(identity, raw).sourceHash;
  vault.failNextWrite = true;

  const writer = new NoteWriter(vault);
  await assert.rejects(() =>
    writer.writeMetadata({
      identity,
      path,
      expectedSourceHash,
      metadata: metadataFor({ identity }),
      isAppleAnnotation: false,
      writeMindmapSection: false,
      removeMindmapSection: false,
    }),
  );
  assert.equal(vault.files.get(path), raw, "the committed vault content must be unchanged after a failed write");
});

void test("writeMetadata is idempotent across ten cycles for an ordinary note", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Notes/Example.md");
  const raw = "---\ntitle: Example\n---\nBody.\n";
  vault.files.set(path, raw);
  const identity = identityFor(path);
  const expectedSourceHash = projectSource(identity, raw).sourceHash;
  const writer = new NoteWriter(vault);
  const options = {
    identity,
    path,
    expectedSourceHash,
    metadata: metadataFor({ identity }),
    isAppleAnnotation: false,
    relatedLinks: [{ path: canonicalizePath("Notes/Other.md"), kind: "core" as const }],
    writeMindmapSection: true,
    removeMindmapSection: false,
  };
  let lastContent: string | undefined;
  for (let i = 0; i < 10; i += 1) {
    const result = await writer.writeMetadata(options);
    if (lastContent !== undefined) {
      assert.equal(result.content, lastContent);
    }
    lastContent = result.content;
  }
  assert.equal(vault.writeCount, 1, "only the first of ten identical cycles should touch the vault");
});

void test("writeMetadata is idempotent across ten cycles for an Apple annotation note", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Books/Apple Books/Author/Book/Annotations/Quote.md");
  const raw = "---\ntype: apple-books-annotation\n---\n> Quote.\n";
  vault.files.set(path, raw);
  const identity = annotationIdentityFor(path, "annotation-1");
  const expectedSourceHash = projectSource(identity, raw).sourceHash;
  const writer = new NoteWriter(vault);
  const options = {
    identity,
    path,
    expectedSourceHash,
    metadata: metadataFor({ identity, concepts: ["Idea"], related: [] }),
    isAppleAnnotation: true,
    writeMindmapSection: false,
    removeMindmapSection: false,
  };
  let lastContent: string | undefined;
  for (let i = 0; i < 10; i += 1) {
    const result = await writer.writeMetadata(options);
    if (lastContent !== undefined) {
      assert.equal(result.content, lastContent);
    }
    lastContent = result.content;
  }
  assert.equal(vault.writeCount, 1);
});

void test("writeMetadata fails closed and performs no vault read when path does not equal identity.canonicalPath", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Notes/Example.md");
  const otherPath = canonicalizePath("Notes/Other.md");
  vault.files.set(path, "---\ntitle: Example\n---\nBody.\n");
  const identity = identityFor(path);

  const writer = new NoteWriter(vault);
  await assert.rejects(
    () =>
      writer.writeMetadata({
        identity,
        path: otherPath,
        expectedSourceHash: "a".repeat(64),
        metadata: metadataFor({ identity }),
        isAppleAnnotation: false,
        writeMindmapSection: false,
        removeMindmapSection: false,
      }),
    (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID",
  );
});

void test("writeMetadata fails closed when metadata.identity does not match the note identity being written", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Notes/Example.md");
  const raw = "---\ntitle: Example\n---\nBody.\n";
  vault.files.set(path, raw);
  const identity = identityFor(path);
  const otherIdentity = identityFor(canonicalizePath("Notes/Other.md"));
  const expectedSourceHash = projectSource(identity, raw).sourceHash;

  const writer = new NoteWriter(vault);
  await assert.rejects(
    () =>
      writer.writeMetadata({
        identity,
        path,
        expectedSourceHash,
        metadata: metadataFor({ identity: otherIdentity }),
        isAppleAnnotation: false,
        writeMindmapSection: false,
        removeMindmapSection: false,
      }),
    (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID",
  );
  assert.equal(vault.writeCount, 0);
});

void test("writeMetadata fails closed when isAppleAnnotation disagrees with identity.kind (ordinary identity, claimed annotation)", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Notes/Example.md");
  const raw = "---\ntitle: Example\n---\nBody.\n";
  vault.files.set(path, raw);
  const identity = identityFor(path);
  const expectedSourceHash = projectSource(identity, raw).sourceHash;

  const writer = new NoteWriter(vault);
  await assert.rejects(
    () =>
      writer.writeMetadata({
        identity,
        path,
        expectedSourceHash,
        metadata: metadataFor({ identity }),
        isAppleAnnotation: true,
        writeMindmapSection: false,
        removeMindmapSection: false,
      }),
    (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID",
  );
  assert.equal(vault.writeCount, 0);
});

void test("writeMetadata fails closed when isAppleAnnotation disagrees with identity.kind (annotation identity, claimed ordinary)", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Books/Apple Books/Author/Book/Annotations/Quote.md");
  const raw = "---\ntype: apple-books-annotation\n---\n> Quote.\n";
  vault.files.set(path, raw);
  const identity = annotationIdentityFor(path, "annotation-1");
  const expectedSourceHash = projectSource(identity, raw).sourceHash;

  const writer = new NoteWriter(vault);
  await assert.rejects(
    () =>
      writer.writeMetadata({
        identity,
        path,
        expectedSourceHash,
        metadata: metadataFor({ identity }),
        isAppleAnnotation: false,
        writeMindmapSection: false,
        removeMindmapSection: false,
      }),
    (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID",
  );
  assert.equal(vault.writeCount, 0);
});

void test("writeMetadata fails closed on a malformed expectedSourceHash without reading the vault", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Notes/Example.md");
  vault.files.set(path, "---\ntitle: Example\n---\nBody.\n");
  const identity = identityFor(path);

  const writer = new NoteWriter(vault);
  await assert.rejects(
    () =>
      writer.writeMetadata({
        identity,
        path,
        expectedSourceHash: "not-a-real-hash",
        metadata: metadataFor({ identity }),
        isAppleAnnotation: false,
        writeMindmapSection: false,
        removeMindmapSection: false,
      }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("writeMetadata wraps a vault write failure as a structured EngineError without leaking the adapter's raw error text", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Notes/Example.md");
  const raw = "---\ntitle: Example\n---\nBody.\n";
  vault.files.set(path, raw);
  const identity = identityFor(path);
  const expectedSourceHash = projectSource(identity, raw).sourceHash;
  const secretMessage = "SECRET-INTERNAL-VAULT-PATH-/private/leak";
  vault.modify = async () => {
    throw new Error(secretMessage);
  };

  const writer = new NoteWriter(vault);
  try {
    await writer.writeMetadata({
      identity,
      path,
      expectedSourceHash,
      metadata: metadataFor({ identity }),
      isAppleAnnotation: false,
      relatedLinks: [{ path: canonicalizePath("Notes/Other.md"), kind: "core" }],
      writeMindmapSection: true,
      removeMindmapSection: false,
    });
    assert.fail("expected writeMetadata to throw");
  } catch (error) {
    assert.ok(isEngineError(error));
    assert.equal((error as { code: string }).code, "VAULT_WRITE_FAILED");
    const serialized = JSON.stringify(error);
    assert.doesNotMatch(serialized, new RegExp(secretMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch((error as Error).message, /SECRET-INTERNAL/);
  }
});
