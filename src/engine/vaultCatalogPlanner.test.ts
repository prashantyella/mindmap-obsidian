import test from "node:test";
import assert from "node:assert/strict";

import { findCatalogItemByAnnotationId, planCatalogSample, streamFullCatalogDiscovery, type CatalogTextReader } from "./vaultCatalogPlanner";

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

void test("streamFullCatalogDiscovery returns content-free items (identity + sourceHash only, never rawContent) for every eligible note", async () => {
  const files = { "Notes/a.md": NOTE_TEXT, "Notes/b.md": NOTE_TEXT + " extra" };
  const result = await streamFullCatalogDiscovery(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files));
  assert.equal(result.items.length, 2);
  for (const item of result.items) {
    assert.equal(Object.prototype.hasOwnProperty.call(item, "rawContent"), false, "streamed items must never carry rawContent");
    assert.equal(typeof item.sourceHash, "string");
    assert.match(item.sourceHash, /^[0-9a-f]{64}$/);
  }
  assert.ok(result.totalBytesRead > 0);
  assert.equal(result.aborted, false);
});

void test("streamFullCatalogDiscovery never reads past an aborted signal", async () => {
  const files: Record<string, string> = { "Notes/a.md": NOTE_TEXT, "Notes/b.md": NOTE_TEXT, "Notes/c.md": NOTE_TEXT };
  const controller = new AbortController();
  let reads = 0;
  const countingReader: CatalogTextReader = {
    async readText(relpath: string) {
      reads += 1;
      if (reads >= 2) controller.abort();
      return files[relpath];
    },
  };
  const result = await streamFullCatalogDiscovery(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, countingReader, controller.signal);
  assert.equal(result.aborted, true);
  assert.ok(result.items.length < 3, "abort must stop the walk before every candidate is considered");
});

void test("streamFullCatalogDiscovery stops once maxTotalBytes is reached, bounding total memory footprint regardless of item count", async () => {
  const files = { "Notes/a.md": NOTE_TEXT, "Notes/b.md": NOTE_TEXT, "Notes/c.md": NOTE_TEXT };
  const byteBound = Buffer.byteLength(NOTE_TEXT, "utf8");
  const result = await streamFullCatalogDiscovery(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files), undefined, undefined, byteBound);
  assert.equal(result.aborted, true);
  assert.equal(result.items.length, 1, "the walk must stop after the byte bound is reached, never processing every candidate");
});

void test("findCatalogItemByAnnotationId returns the single matching annotation's identity/rawContent without scanning further once found", async () => {
  const annotationText = ["---", "type: apple-books-annotation", "annotation_id: abc123", "---", "This annotation quote has more than eight words in total, for sure."].join("\n");
  const files = { "Books/Apple Books/Author/Book/Annotations/note.md": annotationText, "Notes/other.md": NOTE_TEXT };
  const found = await findCatalogItemByAnnotationId(Object.keys(files), { scopeFolders: [], minimumWords: 5 }, reader(files), "abc123");
  assert.ok(found);
  assert.equal(found?.identity.appleAnnotationId, "abc123");
  assert.equal(found?.rawContent, annotationText);
});

void test("findCatalogItemByAnnotationId returns null when no candidate matches", async () => {
  const files = { "Notes/other.md": NOTE_TEXT };
  const found = await findCatalogItemByAnnotationId(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files), "does-not-exist");
  assert.equal(found, null);
});

void test("streamFullCatalogDiscovery (10B cutover prerequisite 3) counts bytes for a SKIPPED/ineligible file too -- a too-short note that was read and rejected still counts toward totalBytesRead", async () => {
  const tooShort = "only three words";
  const files = { "Notes/short.md": tooShort };
  const result = await streamFullCatalogDiscovery(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 30 }, reader(files));
  assert.equal(result.items.length, 0, "the too-short note must never become an accepted item");
  assert.equal(result.skipReasonCounts.TOO_SHORT, 1);
  assert.equal(result.totalBytesRead, Buffer.byteLength(tooShort, "utf8"), "the skipped note's body was still actually read off disk and must count toward the byte budget");
});

void test("streamFullCatalogDiscovery (10B cutover prerequisite 3) stops once maxTotalBytes is reached from SKIPPED reads alone, even with zero accepted items", async () => {
  const tooShort = "only three words";
  const files = { "Notes/a.md": tooShort, "Notes/b.md": tooShort, "Notes/c.md": tooShort };
  const byteBound = Buffer.byteLength(tooShort, "utf8");
  const result = await streamFullCatalogDiscovery(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 30 }, reader(files), undefined, undefined, byteBound);
  assert.equal(result.items.length, 0);
  assert.equal(result.aborted, true, "the walk must stop once skipped-file reads alone exhaust the byte budget");
  assert.equal(result.totalBytesRead, byteBound);
});

void test("streamFullCatalogDiscovery (item 4) never accepts the item that would cross maxTotalBytes, but still counts its bytes as read -- a byte budget can never be silently exceeded by one oversized note", async () => {
  const small = NOTE_TEXT;
  const large = NOTE_TEXT + " " + "extra ".repeat(200);
  const files = { "Notes/a-small.md": small, "Notes/b-large.md": large };
  const smallBytes = Buffer.byteLength(small, "utf8");
  const largeBytes = Buffer.byteLength(large, "utf8");
  // Budget fits the first (small) item alone, but not both -- the large second item would cross it.
  const byteBound = smallBytes + 10;
  assert.ok(largeBytes > 10, "test fixture sanity: the large note must not itself fit in the remaining headroom");

  const result = await streamFullCatalogDiscovery(Object.keys(files), { scopeFolders: ["Notes"], minimumWords: 5 }, reader(files), undefined, undefined, byteBound);
  assert.equal(result.items.length, 1, "the byte-crossing second item must never be accepted into items");
  assert.equal(result.aborted, true);
  assert.equal(result.totalBytesRead, smallBytes + largeBytes, "the byte-crossing item's bytes must still be counted as read, even though it was not accepted");
});
