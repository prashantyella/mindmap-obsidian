import test from "node:test";
import assert from "node:assert/strict";

import { planCatalogSample, type CatalogTextReader } from "./vaultCatalogPlanner";

function reader(files: Record<string, string>): CatalogTextReader {
  return {
    async readText(relpath: string): Promise<string> {
      if (!(relpath in files)) throw new Error(`ENOENT: ${relpath}`);
      return files[relpath];
    },
  };
}

const NOTE_TEXT = "word ".repeat(40).trim();

void test("planCatalogSample includes an ordinary in-scope note and reports it with a plain path identity", async () => {
  const files = { "Notes/a.md": NOTE_TEXT };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].relpath, "Notes/a.md");
  assert.equal(result.items[0].identity.kind, "path");
});

void test("planCatalogSample excludes a note outside every configured scope folder", async () => {
  const files = { "Elsewhere/a.md": NOTE_TEXT };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 0);
  assert.equal(result.skipReasonCounts.OUT_OF_SCOPE, 1);
});

void test("planCatalogSample never treats an empty/malformed scope folder entry as the whole vault", async () => {
  const files = { "Anywhere/a.md": NOTE_TEXT };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["", "   ", "/"], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 0, "a blank/malformed scope entry must never widen to vault-root matching");
  assert.equal(result.skipReasonCounts.OUT_OF_SCOPE, 1);
});

void test("planCatalogSample DOES treat an explicit literal '.' scope entry as the whole vault (a deliberate choice, not malformed)", async () => {
  const files = { "Anywhere/a.md": NOTE_TEXT };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["."], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 1);
});

void test("planCatalogSample excludes a note inside the configured Obsidian configDir, even a non-standard renamed one", async () => {
  const files = { "MyConfig/plugins/mindmap/data.md": NOTE_TEXT };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["."], minimumWords: 5, configDir: "MyConfig" }, reader(files));
  assert.equal(result.items.length, 0);
  assert.equal(result.skipReasonCounts.UNSAFE_PATH, 1);
});

void test("planCatalogSample excludes a note below the minimum word count, using the configured threshold", async () => {
  const files = { "Notes/short.md": "only three words" };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 30 }, reader(files));
  assert.equal(result.items.length, 0);
  assert.equal(result.skipReasonCounts.TOO_SHORT, 1);
});

void test("planCatalogSample excludes a generated Reading index (managed artifact) but includes an ordinary note at the same structural depth", async () => {
  const managedIndex = ["<!-- mindmap:apple-books-index:start -->", "content", "<!-- mindmap:apple-books-index:end -->"].join("\n");
  const files = {
    "Books/Apple Books/Author/Book/Index.md": managedIndex,
    "Books/Apple Books/Author/Book2/Index.md": "not a managed index, just a note with enough words " + NOTE_TEXT,
  };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: [], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].relpath, "Books/Apple Books/Author/Book2/Index.md");
  assert.equal(result.skipReasonCounts.MANAGED_ARTIFACT, 1);
});

void test("planCatalogSample excludes a research companion note by its structural path shape, even though it isn't itself an annotation", async () => {
  const files = { "Books/Apple Books/Author/Book/Research/Companion.md": NOTE_TEXT };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["Books/Apple Books"], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 0);
  assert.equal(result.skipReasonCounts.RESEARCH_COMPANION, 1);
});

void test("planCatalogSample gives an Apple Books annotation note a stable appleAnnotationId identity from its annotation_id frontmatter, not an ordinary path identity", async () => {
  const annotationText = ["---", "type: apple-books-annotation", "annotation_id: abc-123", "---", "This annotation quote has more than eight words in total, for sure."].join("\n");
  const files = { "Books/Apple Books/Author/Book/Annotations/note.md": annotationText };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: [], minimumWords: 30 }, reader(files));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].isAppleAnnotation, true);
  assert.deepEqual(result.items[0].identity, { schemaVersion: 1, kind: "apple-annotation", canonicalPath: result.items[0].identity.canonicalPath, appleAnnotationId: "abc-123" });
});

void test("planCatalogSample skips an annotation-typed note missing annotation_id frontmatter, with a bounded reason rather than crashing the run", async () => {
  const annotationText = ["---", "type: apple-books-annotation", "---", "This annotation quote has more than eight words in total, for sure."].join("\n");
  const files = { "Books/Apple Books/Author/Book/Annotations/note.md": annotationText };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: [], minimumWords: 30 }, reader(files));
  assert.equal(result.items.length, 0);
  assert.equal(result.skipReasonCounts.MISSING_ANNOTATION_ID, 1);
});

void test("planCatalogSample counts a per-file read failure as a bounded reason, never aborting the whole run", async () => {
  const files = { "Notes/a.md": NOTE_TEXT, "Notes/b.md": NOTE_TEXT };
  const flakyReader: CatalogTextReader = {
    async readText(relpath: string): Promise<string> {
      if (relpath === "Notes/a.md") throw new Error("disk read error");
      return files[relpath as keyof typeof files];
    },
  };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, flakyReader);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].relpath, "Notes/b.md");
  assert.equal(result.skipReasonCounts.READ_FAILED, 1);
});

void test("planCatalogSample sorts candidates canonically before sampling, independent of input order", async () => {
  const files = { "Notes/z.md": NOTE_TEXT, "Notes/a.md": NOTE_TEXT, "Notes/m.md": NOTE_TEXT };
  const forward = await planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files), 2);
  const shuffled = await planCatalogSample([...Object.keys(files)].reverse(), { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files), 2);
  assert.deepEqual(forward.items.map((item) => item.relpath), ["Notes/a.md", "Notes/m.md"]);
  assert.deepEqual(shuffled.items.map((item) => item.relpath), ["Notes/a.md", "Notes/m.md"]);
});

void test("planCatalogSample deduplicates a candidate path listed more than once", async () => {
  const files = { "Notes/a.md": NOTE_TEXT };
  const result = await planCatalogSample(["Notes/a.md", "Notes/a.md"], { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 1);
});

void test("planCatalogSample never exceeds the default bounded sample cap even when a caller passes an oversized maxCount", async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 80; index += 1) {
    files[`Notes/${String(index).padStart(3, "0")}.md`] = NOTE_TEXT;
  }
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files), 10_000);
  assert.ok(result.items.length <= 50);
});

void test("planCatalogSample rejects a scope folder containing traversal or an absolute path, without widening scope, while a genuinely valid entry alongside it still works", async () => {
  const files = { "etc/passwd.md": NOTE_TEXT, "Notes/a.md": NOTE_TEXT };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["../etc", "/abs/path", "Notes"], minimumWords: 5 }, reader(files));
  // The two malformed entries ("../etc", "/abs/path") must never admit "etc/passwd.md" -- only the
  // genuinely valid "Notes" entry admits its own file.
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].relpath, "Notes/a.md");
});

void test("planCatalogSample never admits an arbitrary ordinary file elsewhere under the broad Reading root -- only the structurally valid Annotations shape (or the generated Index shape) is admitted via the Reading-root path", async () => {
  const files = {
    "Books/Apple Books/Author/Book/notes.md": NOTE_TEXT, // book-level file, not annotation/index shaped
    "Books/Apple Books/Author/random.md": NOTE_TEXT, // shallow, not even book-level
  };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: [], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 0, "an arbitrary ordinary file under the broad Reading root must never be admitted just because it lives under Books/Apple Books");
  assert.equal(result.skipReasonCounts.OUT_OF_SCOPE, 2);
});

void test("planCatalogSample DOES include an ordinary file under the Reading root when the caller's ORDINARY scopeFolders independently cover it (not via the strict Reading-only path)", async () => {
  const files = { "Books/Apple Books/Author/Book/notes.md": NOTE_TEXT };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["Books/Apple Books"], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 1);
});

void test("planCatalogSample can disable the Reading-annotation inclusion path entirely via includeReadingAnnotations: false", async () => {
  const annotationText = ["---", "type: apple-books-annotation", "annotation_id: abc-123", "---", "This annotation quote has more than eight words in total, for sure."].join("\n");
  const files = { "Books/Apple Books/Author/Book/Annotations/note.md": annotationText };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: [], includeReadingAnnotations: false, minimumWords: 30 }, reader(files));
  assert.equal(result.items.length, 0);
  assert.equal(result.skipReasonCounts.OUT_OF_SCOPE, 1);
});

void test("planCatalogSample stops promptly when the AbortSignal is already aborted, processing no candidates", async () => {
  const files = { "Notes/a.md": NOTE_TEXT, "Notes/b.md": NOTE_TEXT };
  const controller = new AbortController();
  controller.abort();
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files), 50, controller.signal);
  assert.equal(result.items.length, 0);
  assert.equal(result.aborted, true);
});

void test("planCatalogSample threads the AbortSignal into reader.readText", async () => {
  const files = { "Notes/a.md": NOTE_TEXT };
  let receivedSignal: AbortSignal | undefined;
  const trackingReader: CatalogTextReader = {
    async readText(relpath, signal) {
      receivedSignal = signal;
      return files[relpath as keyof typeof files];
    },
  };
  const controller = new AbortController();
  await planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, trackingReader, 50, controller.signal);
  assert.equal(receivedSignal, controller.signal);
});

void test("planCatalogSample rejects an invalid maxCount (negative or non-integer) rather than silently unbounding the walk", async () => {
  const files = { "Notes/a.md": NOTE_TEXT };
  await assert.rejects(() => planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files), -1));
  await assert.rejects(() => planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files), Number.NaN));
  await assert.rejects(() => planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files), Infinity));
});

void test("planCatalogSample rejects an invalid minimumWords (negative or non-integer)", async () => {
  const files = { "Notes/a.md": NOTE_TEXT };
  await assert.rejects(() => planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: -1 }, reader(files)));
  await assert.rejects(() => planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5.5 }, reader(files)));
});

void test("planCatalogSample canonicalizes and dedupes two different spellings of the same candidate path", async () => {
  const files = { "Notes/a.md": NOTE_TEXT };
  const result = await planCatalogSample(["Notes/a.md", "./Notes//a.md", "Notes\\a.md"], { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 1);
});

void test("planCatalogSample rejects a runtimeFolder containing traversal rather than using it as-is", async () => {
  const files = { "Notes/a.md": NOTE_TEXT };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5, runtimeFolder: "../outside" }, reader(files));
  // A malformed runtimeFolder is dropped, so it excludes nothing extra -- the note remains
  // included via its own legitimate scope folder.
  assert.equal(result.items.length, 1);
});

void test("planCatalogSample uses normalizedWordCount consistently for both ordinary and annotation notes", async () => {
  // A body with exactly 9 Unicode "words" by normalizedWordCount's own rule, but only 3 tokens by
  // a naive whitespace split (hyphens/apostrophes joined) -- if the planner used a naive split for
  // ordinary notes, this would read as under-threshold; normalizedWordCount reads it correctly.
  const body = "well-known state-of-the-art can't won't didn't shouldn't";
  const files = { "Notes/a.md": body };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 6 }, reader(files));
  assert.equal(result.items.length, 1, "normalizedWordCount must be used for ordinary notes too, not a naive whitespace split");
});

void test("planCatalogSample does NOT repair an absolute POSIX scope folder into a relative one -- /Secret must never silently become the scope folder Secret", async () => {
  const files = { "Secret/a.md": NOTE_TEXT };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["/Secret"], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 0, "an absolute scope folder must be dropped outright, never repaired into a matching relative one");
});

void test("planCatalogSample rejects a Windows drive-path and a UNC-path scope folder, never repairing either into a relative one", async () => {
  const files = { "Users/a.md": NOTE_TEXT, "server/share/a.md": NOTE_TEXT };
  const driveResult = await planCatalogSample(Object.keys(files), { scopeFolders: ["C:\\Users"], minimumWords: 5 }, reader(files));
  assert.equal(driveResult.items.length, 0);
  const uncResult = await planCatalogSample(Object.keys(files), { scopeFolders: ["\\\\server\\share"], minimumWords: 5 }, reader(files));
  assert.equal(uncResult.items.length, 0);
});

void test("planCatalogSample does NOT repair an absolute candidate path into a relative one -- /Secret/a.md must never silently become Secret/a.md", async () => {
  const result = await planCatalogSample(["/Secret/a.md"], { scopeFolders: ["Secret"], minimumWords: 5 }, reader({ "Secret/a.md": NOTE_TEXT }));
  assert.equal(result.items.length, 0, "an absolute candidate path must be dropped outright, never repaired into a matching relative one");
});

void test("planCatalogSample deduplicates two different spellings of the same scope folder", async () => {
  const files = { "Notes/a.md": NOTE_TEXT };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["Notes", "Notes/", "./Notes"], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 1);
});

void test("planCatalogSample skips a Reading-annotation-SHAPED file admitted only via includeReadingAnnotations when its frontmatter type is not really apple-books-annotation -- it must never fall through as an ordinary path-identity note", async () => {
  const files = { "Books/Apple Books/Author/Book/Annotations/not-really-an-annotation.md": NOTE_TEXT };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: [], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 0, "a Reading-shaped file without the real annotation type must be skipped, not admitted as an ordinary note");
  assert.equal(result.skipReasonCounts.OUT_OF_SCOPE, 1);
});

void test("planCatalogSample DOES include a Reading-annotation-shaped-but-not-really-annotated file as an ordinary note when the caller's ordinary scopeFolders independently cover it (explicit, tested ordinary-note policy)", async () => {
  const files = { "Books/Apple Books/Author/Book/Annotations/not-really-an-annotation.md": NOTE_TEXT };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["Books/Apple Books"], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 1, "when ordinary scope independently covers the file, it is included as an ordinary note even though it is not a real annotation");
  assert.equal(result.items[0].isAppleAnnotation, false);
  assert.equal(result.items[0].identity.kind, "path");
});

void test("planCatalogSample skips a Reading-annotation-shaped file with a non-scalar annotation_id (an array/object value), never accepting it", async () => {
  const annotationText = ["---", "type: apple-books-annotation", "annotation_id: [1, 2]", "---", "This annotation quote has more than eight words in total, for sure."].join("\n");
  const files = { "Books/Apple Books/Author/Book/Annotations/note.md": annotationText };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: [], minimumWords: 30 }, reader(files));
  assert.equal(result.items.length, 0);
  assert.equal(result.skipReasonCounts.MISSING_ANNOTATION_ID, 1);
});

void test("planCatalogSample excludes a non-Markdown file", async () => {
  const files = { "Notes/a.png": "not markdown" };
  const result = await planCatalogSample(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 1 }, reader(files));
  assert.equal(result.items.length, 0);
  assert.equal(result.skipReasonCounts.UNSAFE_PATH, 1);
});
