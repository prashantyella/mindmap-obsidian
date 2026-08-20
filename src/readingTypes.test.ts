import test from "node:test";
import assert from "node:assert/strict";

import {
  annotationIsTooShort,
  baseAnnotationNotePath,
  createEmptyReadingState,
  isSafeReadingPath,
  planAnnotationPaths,
  sanitizePathComponent,
  validateAppleBooksReaderPayload,
  type AppleBooksAnnotation,
} from "./readingTypes";

function annotation(overrides: Partial<AppleBooksAnnotation> = {}): AppleBooksAnnotation {
  return {
    annotation_id: "aeannotation:1",
    quote: "One two three four five six seven eight nine",
    book_title: "A Book",
    author: "An Author",
    created_at: "2026-08-17T00:00:00Z",
    ...overrides,
  };
}

test("validates reader payloads and rejects malformed or duplicate annotations", () => {
  const payload = validateAppleBooksReaderPayload({
    version: 1,
    status: "success",
    count: 1,
    annotations: [annotation()],
    diagnostics: [],
  });

  assert.equal(payload.annotations[0]?.annotation_id, "aeannotation:1");
  assert.throws(() => validateAppleBooksReaderPayload({ ...payload, version: 2 }), /Unsupported Apple Books payload version/);
  assert.throws(() => validateAppleBooksReaderPayload({ ...payload, annotations: [annotation(), annotation()] , count: 2 }), /duplicate annotation ID/);
  assert.throws(() => validateAppleBooksReaderPayload({ ...payload, annotations: [{ ...annotation(), quote: "" }] }), /quote/);
  assert.throws(() => validateAppleBooksReaderPayload({ ...payload, annotations: [{ ...annotation(), created_at: "not-a-date" }] }), /created_at.*ISO date-time/);
  assert.throws(() => validateAppleBooksReaderPayload({ ...payload, annotations: [{ ...annotation(), modified_at: "2026-99-99T00:00:00Z" }] }), /modified_at.*ISO date-time/);
  assert.throws(() => validateAppleBooksReaderPayload({ ...payload, status: "partial", skipped_rows: 0 }), /skipped_rows/);
  assert.equal(validateAppleBooksReaderPayload({ ...payload, status: "empty", count: 0, annotations: [] }).status, "empty");
  assert.throws(() => validateAppleBooksReaderPayload({ ...payload, status: "empty" }), /empty results must contain zero annotations/);

  // Regression: the reader emits absent optional fields as JSON null (every
  // highlight without a note carries user_note: null, chapter: null). These
  // must be accepted as "field absent", not rejected as a non-empty string.
  const withNulls = validateAppleBooksReaderPayload({
    ...payload,
    annotations: [{ ...annotation(), user_note: null, chapter: null, location: null }],
  });
  assert.equal(withNulls.annotations[0]?.user_note, undefined);
  assert.equal(withNulls.annotations[0]?.chapter, undefined);
});

test("sanitizes Unicode, reserved, empty, and traversal-like path components", () => {
  assert.equal(sanitizePathComponent("CON", "Fallback"), "CON-");
  assert.equal(sanitizePathComponent("../", "Fallback"), "Fallback");
  assert.equal(sanitizePathComponent("   ", "Fallback"), "Fallback");
  assert.match(sanitizePathComponent("  Café 📚  ", "Fallback"), /Café 📚/);
  assert.equal(sanitizePathComponent(".obsidian", "Fallback"), "obsidian");
  assert.equal(sanitizePathComponent(".git", "Fallback"), "git");
  assert.equal(sanitizePathComponent(".trash", "Fallback"), "trash");
  assert.equal(sanitizePathComponent("...", "Fallback"), "Fallback");

  const path = baseAnnotationNotePath(annotation({ author: "../CON", book_title: "A/B" }));
  assert.equal(isSafeReadingPath(path), true);
  assert.equal(path.includes(".."), false);
  assert.equal(path.includes(".obsidian"), false);
});

test("keeps stored paths stable and resolves occupied collisions deterministically", () => {
  const first = annotation({ annotation_id: "first" });
  const second = annotation({ annotation_id: "second" });
  const state = createEmptyReadingState();
  state.annotations.first = {
    contentHash: "hash",
    notePath: "Books/Apple Books/An Author/A Book/Annotations/permanent.md",
    importedAt: "2026-08-17T00:00:00Z",
    researchStatus: "off",
    processedAt: null,
  };
  const paths = planAnnotationPaths([first, second], state, [baseAnnotationNotePath(second)]);

  assert.equal(paths.find((item) => item.annotationId === "first")?.notePath, "Books/Apple Books/An Author/A Book/Annotations/permanent.md");
  assert.match(paths.find((item) => item.annotationId === "second")?.notePath ?? "", /-\w+\.md$/);
  assert.equal(new Set(paths.map((item) => item.notePath)).size, 2);
});

test("keeps a preferred path even when it is not present in persisted state", () => {
  const preferred = "Books/Apple Books/An Author/A Book/Annotations/adopted.md";
  const planned = planAnnotationPaths([annotation({ annotation_id: "adopted" })], createEmptyReadingState(), [], { adopted: preferred });

  assert.deepEqual(planned, [{ annotationId: "adopted", notePath: preferred }]);
});

test("uses quote and note word count for the eight-word eligibility threshold", () => {
  assert.equal(annotationIsTooShort(annotation({ quote: "one two three", user_note: "four five" })), true);
  assert.equal(annotationIsTooShort(annotation({ quote: "one two three four", user_note: "five six seven eight" })), false);
});
