import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, stableNoteIdentity } from "./contracts";
import type { MetadataInferenceProvider } from "./metadataPipeline";
import { runMetadataPipeline } from "./metadataPipeline";
import { NoteWriter, type NoteVaultAdapter } from "./noteWriter";
import { projectSource } from "./sourceProjection";

/**
 * End-to-end proof for review-fix item 1: a plain `MetadataOutputV1`
 * produced by `runMetadataPipeline` (metadataPipeline.ts, which never
 * knows about Apple annotations) must pass through `NoteWriter`'s single
 * write seam and come out formatted EXACTLY ONCE -- never double-wikilinked,
 * never dropping a related link, with summary/tags cleared only at the
 * write seam (not inside the pipeline output itself).
 */
class FakeVault implements NoteVaultAdapter {
  files = new Map<string, string>();

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async modify(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async create(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async ensureFolder(): Promise<void> {}
}

function fakeProvider(response: string): MetadataInferenceProvider {
  return { complete: async () => response };
}

const CONFIG = {
  model: "m",
  maxTokens: 512,
  tagLimit: 5,
  conceptLimit: 5,
  conceptMaxWords: 4,
  conceptCaseMode: "none" as const,
  controlledTags: [],
  allowFreeTags: true,
  tagMinLen: 0,
  tagMaxWords: 3,
  tagAliases: {},
};

void test("end-to-end: an ordinary note's runMetadataPipeline output writes plain (non-wikilinked) frontmatter values through NoteWriter", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Notes/Example.md");
  const raw = "---\ntitle: Example\n---\nBody text.\n";
  vault.files.set(path, raw);
  const identity = stableNoteIdentity(path);
  const expectedSourceHash = projectSource(identity, raw).sourceHash;

  const provider = fakeProvider('{"summary":"A concise summary.","tags":["Idea One"],"concepts":["Concept Idea"]}');
  const metadata = await runMetadataPipeline(provider, CONFIG, { identity, text: "Body text.", related: ["Notes/Other.md"] });

  const writer = new NoteWriter(vault);
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
  assert.match(result.content, /summary: A concise summary\./);
  assert.match(result.content, /concepts:\n {2}- Concept Idea/);
  assert.match(result.content, /related:\n {2}- Notes\/Other\.md/, "an ordinary note's related field is the plain path, never a wikilink");
  assert.doesNotMatch(result.content, /\[\[/, "no wikilink syntax anywhere for an ordinary note");
});

void test("end-to-end: an Apple annotation note's runMetadataPipeline output is wikilink-rendered exactly once by NoteWriter, retains valid related links, and clears summary/tags only at the write seam", async () => {
  const vault = new FakeVault();
  const path = canonicalizePath("Books/Apple Books/Author/Book/Annotations/Quote.md");
  const raw = "---\ntitle: Quote\ntype: apple-books-annotation\nsummary: stale\ntags:\n  - old\n---\n> The annotated quote.\n\nA user note.\n";
  vault.files.set(path, raw);
  const identity = stableNoteIdentity(path, "annotation-1");
  const expectedSourceHash = projectSource(identity, raw).sourceHash;

  const provider = fakeProvider('{"summary":"ignored for annotations","tags":["ignored-tag"],"concepts":["Idea One","Idea Two"]}');
  // Two valid vault-relative .md related candidates -- proves both survive the round trip
  // through the plain pipeline output and NoteWriter's single wikilink-rendering pass, with
  // neither dropped.
  const metadata = await runMetadataPipeline(provider, CONFIG, {
    identity,
    text: "The annotated quote. A user note.",
    related: ["Notes/Other.md", "Notes/Second.md"],
  });

  // The pipeline output itself must still be PLAIN -- proves metadataPipeline.ts never
  // wikilink-renders anything, regardless of note kind.
  assert.deepEqual(metadata.concepts, ["Idea One", "Idea Two"]);
  assert.deepEqual(metadata.related, ["Notes/Other.md", "Notes/Second.md"]);
  assert.equal(metadata.summary, "ignored for annotations");
  assert.deepEqual(metadata.tags, ["ignored-tag"]);

  const writer = new NoteWriter(vault);
  const result = await writer.writeMetadata({
    identity,
    path,
    expectedSourceHash,
    metadata,
    isAppleAnnotation: true,
    writeMindmapSection: false,
    removeMindmapSection: false,
  });

  assert.equal(result.status, "written");
  // Cleared only at the write seam: the pipeline's own output (summary/tags) was non-empty above.
  assert.doesNotMatch(result.content, /^summary:/m);
  assert.doesNotMatch(result.content, /^tags:/m);
  // Exactly one wikilink conversion each -- never double-bracketed ("[[[[...".
  assert.match(result.content, /concepts:\n {2}- '\[\[Idea One]]'\n {2}- '\[\[Idea Two]]'/);
  assert.doesNotMatch(result.content, /\[\[\[\[/);
  assert.match(result.content, /related:\n {2}- '\[\[Notes\/Other\|Other]]'\n {2}- '\[\[Notes\/Second\|Second]]'/);
  // Both related links survived -- neither was dropped by a double-formatting bug.
  assert.match(result.content, /Notes\/Other/);
  assert.match(result.content, /Notes\/Second/);
  // Annotation body rules intact: body stays annotation-only, byte-identical apart from frontmatter.
  assert.match(result.content, /> The annotated quote\.\n\nA user note\.\n$/);
  assert.doesNotMatch(result.content, /mindmap-link/, "Apple annotation notes never gain a generated Related callout");
});
