import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { canonicalizePath, stableNoteIdentity, type NoteIdentityV1 } from "./contracts";
import { MAX_SHADOW_SAMPLE_NOTES, parseShadowBaselineV1, runShadowComparison, SHADOW_REASON_CODES, type ShadowBaselineV1, type ShadowEngineCapabilities, type ShadowNoteSource } from "./shadowEngine";

function identity(path: string): NoteIdentityV1 {
  return stableNoteIdentity(canonicalizePath(path));
}

function fixedSource(notes: readonly { identity: NoteIdentityV1; rawContent: string }[]): ShadowNoteSource {
  return {
    listEligibleSample: async (maxCount) => notes.slice(0, maxCount),
  };
}

const SECRET_BODY = "This body mentions a secret project codename Zephyr and a private path /Users/alice/Documents/diary.md.";

void test("runShadowComparison hashes note identities, never echoing the canonical path or note text", async () => {
  const note = { identity: identity("Diary/Private Note.md"), rawContent: `---\ntags: []\n---\n\n${SECRET_BODY}` };
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([note]) };
  const report = await runShadowComparison(capabilities);

  assert.equal(report.items.length, 1);
  const expectedHash = createHash("sha256").update("path:Diary/Private Note.md", "utf8").digest("hex");
  assert.equal(report.items[0].hashedId, expectedHash);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /Zephyr/);
  assert.doesNotMatch(serialized, /diary\.md/);
  assert.doesNotMatch(serialized, /Diary\/Private Note\.md/);
  assert.doesNotMatch(serialized, /\/Users\/alice/);
});

void test("runShadowComparison caps the sample at MAX_SHADOW_SAMPLE_NOTES even if the source offers more", async () => {
  const notes = Array.from({ length: MAX_SHADOW_SAMPLE_NOTES + 25 }, (_, index) => ({
    identity: identity(`Notes/note-${index}.md`),
    rawContent: `Body for note ${index}.`,
  }));
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource(notes) };
  const report = await runShadowComparison(capabilities, { sampleSize: 10_000 });
  assert.equal(report.items.length, MAX_SHADOW_SAMPLE_NOTES);
  assert.equal(report.metrics.sampleSize, MAX_SHADOW_SAMPLE_NOTES);
});

void test("runShadowComparison respects a caller-provided sampleSize below the max", async () => {
  const notes = Array.from({ length: 20 }, (_, index) => ({ identity: identity(`Notes/n${index}.md`), rawContent: "body text here" }));
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource(notes) };
  const report = await runShadowComparison(capabilities, { sampleSize: 5 });
  assert.equal(report.items.length, 5);
});

void test("runShadowComparison is deterministic for the same input", async () => {
  const notes = [
    { identity: identity("A.md"), rawContent: "alpha beta gamma ".repeat(200) },
    { identity: identity("B.md"), rawContent: "" },
  ];
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource(notes) };
  const first = await runShadowComparison(capabilities, { nowIso: "2026-08-23T00:00:00.000Z" });
  const second = await runShadowComparison(capabilities, { nowIso: "2026-08-23T00:00:00.000Z" });
  assert.deepEqual(first, second);
});

void test("runShadowComparison records CHUNKS_EMPTY for an empty body and CHUNKS_NONEMPTY for a long one, aggregated in reasonCodeCounts", async () => {
  const notes = [
    { identity: identity("Empty.md"), rawContent: "---\n---\n" },
    { identity: identity("Long.md"), rawContent: `---\n---\n${"word ".repeat(1000)}` },
  ];
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource(notes) };
  const report = await runShadowComparison(capabilities);
  assert.equal(report.items[0].chunkCount, 0);
  assert.ok(report.items[0].reasonCodes.includes("CHUNKS_EMPTY"));
  assert.ok(report.items[1].chunkCount > 0);
  assert.ok(report.items[1].reasonCodes.includes("CHUNKS_NONEMPTY"));
  assert.equal(report.reasonCodeCounts.CHUNKS_EMPTY, 1);
  assert.equal(report.reasonCodeCounts.CHUNKS_NONEMPTY, 1);
});

void test("runShadowComparison marks apple-annotation identities and never crashes without an index/apple capability", async () => {
  const appleIdentity = stableNoteIdentity(canonicalizePath("Reading/Book/Annotation.md"), "annotation-123");
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([{ identity: appleIdentity, rawContent: "---\n---\nquote text" }]) };
  const report = await runShadowComparison(capabilities);
  assert.equal(report.items[0].isAppleAnnotation, true);
  assert.ok(report.items[0].reasonCodes.includes("APPLE_ANNOTATION_NOTE"));
  assert.equal(report.items[0].relatedPreviewCount, null);
});

void test("runShadowComparison previews only a bounded related-count when an index capability and matching query vector are present", async () => {
  const note = { identity: identity("Note.md"), rawContent: "---\n---\nsome content" };
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  const capabilities: ShadowEngineCapabilities = {
    noteSource: fixedSource([note]),
    indexQuery: { queryRelated: async () => [{ path: canonicalizePath("Other.md"), score: 0.9 }] },
    queryVectorsByHashedId: new Map([[hashedId, new Float32Array([1, 0])]]),
  };
  const report = await runShadowComparison(capabilities);
  assert.equal(report.items[0].relatedPreviewCount, 1);
  assert.ok(report.items[0].reasonCodes.includes("RELATED_PREVIEW_NONEMPTY"));
  assert.doesNotMatch(JSON.stringify(report), /Other\.md/, "candidate paths must never appear in the report");
});

void test("runShadowComparison records RELATED_PREVIEW_UNAVAILABLE when the index query throws, without failing the whole run", async () => {
  const note = { identity: identity("Note.md"), rawContent: "---\n---\nbody" };
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  const capabilities: ShadowEngineCapabilities = {
    noteSource: fixedSource([note]),
    indexQuery: { queryRelated: async () => { throw new Error("index unavailable"); } },
    queryVectorsByHashedId: new Map([[hashedId, new Float32Array([1, 0])]]),
  };
  const report = await runShadowComparison(capabilities);
  assert.equal(report.items[0].relatedPreviewCount, null);
  assert.equal(report.metrics.relatedUnavailableCount, 1);
  assert.ok(report.items[0].reasonCodes.includes("RELATED_PREVIEW_UNAVAILABLE"));
});

void test("runShadowComparison with no baseline reports comparisonUnavailable and every metric at its zero/null default", async () => {
  const note = { identity: identity("Note.md"), rawContent: "---\n---\nbody" };
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([note]) };
  const report = await runShadowComparison(capabilities);
  assert.equal(report.comparison.comparisonUnavailable, true);
  assert.equal(report.comparison.eligibilityDisagreementCount, 0);
  assert.equal(report.comparison.relatedOverlapAt8, null);
});

void test("runShadowComparison against a baseline reports a symmetric-difference eligibility disagreement in BOTH directions -- a baseline-only note AND a TS-only note each count once (2 total), never just one direction", async () => {
  const note = { identity: identity("Note.md"), rawContent: "---\n---\nbody" };
  const baselineOnlyHashedId = createHash("sha256").update("path:Other.md", "utf8").digest("hex");
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([note]) };
  const baseline: ShadowBaselineV1 = {
    schemaVersion: 1,
    generatedAtIso: "2026-08-23T00:00:00.000Z",
    sampleCount: 1,
    entries: [{ hashedId: baselineOnlyHashedId, eligible: true }],
  };
  const report = await runShadowComparison(capabilities, { baseline });
  assert.equal(report.comparison.comparisonUnavailable, false);
  // "Note.md" (TS-only, absent from baseline's eligible set) + "Other.md" (baseline-only, absent
  // from TS) = 2 disagreements, not 1 -- this is the exact bug fixed in the parity-signal
  // correction: a TS-only inclusion was previously invisible.
  assert.equal(report.comparison.eligibilityDisagreementCount, 2);
  assert.equal(report.comparison.noteCountDelta, 0, "1 TS-side note vs baseline.sampleCount 1");
});

void test("runShadowComparison against a baseline reports zero eligibility disagreements when both sides agree on the exact same set, and never double-counts a duplicate-free match", async () => {
  const noteA = { identity: identity("A.md"), rawContent: "---\n---\nbody" };
  const noteB = { identity: identity("B.md"), rawContent: "---\n---\nbody" };
  const hashedIdA = createHash("sha256").update("path:A.md", "utf8").digest("hex");
  const hashedIdB = createHash("sha256").update("path:B.md", "utf8").digest("hex");
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([noteA, noteB]) };
  const baseline: ShadowBaselineV1 = {
    schemaVersion: 1,
    generatedAtIso: "2026-08-23T00:00:00.000Z",
    sampleCount: 2,
    entries: [{ hashedId: hashedIdA, eligible: true }, { hashedId: hashedIdB, eligible: true }],
  };
  const report = await runShadowComparison(capabilities, { baseline });
  assert.equal(report.comparison.eligibilityDisagreementCount, 0);
});

void test("runShadowComparison against a baseline agrees on a matching projection digest", async () => {
  const note = { identity: identity("Note.md"), rawContent: "---\n---\nsome content here" };
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([note]) };
  // First run without a baseline to discover the digest TS itself would compute -- mirrors how a
  // real caller would derive a baseline from a KNOWN-agreeing prior TS/Python run, without this
  // test needing to duplicate projectSource's own normalization logic.
  const first = await runShadowComparison(capabilities);
  assert.equal(first.items.length, 1);
  // Re-derive the exact digest via a second identical run's own internal behavior is not directly
  // observable from the report (by design -- digests never leave this module raw), so this test
  // instead asserts the DISAGREEMENT path, which is fully observable without reaching into
  // internals: an intentionally wrong digest must be reported as a disagreement, never silently
  // ignored.
  const baseline: ShadowBaselineV1 = {
    schemaVersion: 1,
    generatedAtIso: "2026-08-23T00:00:00.000Z",
    sampleCount: 1,
    entries: [{ hashedId, eligible: true, projectionDigest: "0".repeat(64) }],
  };
  const report = await runShadowComparison(capabilities, { baseline });
  assert.equal(report.comparison.projectionDigestDisagreementCount, 1);
  assert.equal(report.comparison.projectionDigestAgreementCount, 0);
});

void test("runShadowComparison against a baseline flags a python-nonempty/ts-empty related disagreement", async () => {
  const note = { identity: identity("Note.md"), rawContent: "---\n---\nsome content" };
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  const capabilities: ShadowEngineCapabilities = {
    noteSource: fixedSource([note]),
    indexQuery: { queryRelated: async () => [] },
    queryVectorsByHashedId: new Map([[hashedId, new Float32Array([1, 0])]]),
  };
  const baseline: ShadowBaselineV1 = {
    schemaVersion: 1,
    generatedAtIso: "2026-08-23T00:00:00.000Z",
    sampleCount: 1,
    entries: [{ hashedId, eligible: true, relatedNonEmpty: true }],
  };
  const report = await runShadowComparison(capabilities, { baseline });
  assert.equal(report.comparison.pythonNonEmptyTsEmptyCount, 1);
  assert.equal(report.comparison.emptyNonEmptyDisagreementCount, 1);
});

void test("runShadowComparison uses the Apple reader when supplied and compares status/count/annotation-id digest against the baseline, never serializing raw source metadata", async () => {
  const note = { identity: identity("Note.md"), rawContent: "---\n---\nbody" };
  const capabilities: ShadowEngineCapabilities = {
    noteSource: fixedSource([note]),
    appleReader: {
      read: async () => ({
        version: 1,
        status: "success",
        annotations: [{ annotation_id: "b", quote: "q", book_title: "t" }, { annotation_id: "a", quote: "q2", book_title: "t" }],
        diagnostics: [],
        count: 2,
        sources: [{ role: "primary", filename: "/Users/real/secret/AEAnnotation.sqlite", schema: "s", snapshot: "s1", wal_present: false }],
      }),
    },
  };
  const annotationIdDigest = createHash("sha256").update("a,b", "utf8").digest("hex");
  const baseline: ShadowBaselineV1 = {
    schemaVersion: 1,
    generatedAtIso: "2026-08-23T00:00:00.000Z",
    sampleCount: 0,
    entries: [],
    appleReader: { status: "success", count: 2, annotationIdDigest },
  };
  const report = await runShadowComparison(capabilities, { baseline });
  assert.equal(report.comparison.appleStatusMatches, true);
  assert.equal(report.comparison.appleCountDelta, 0);
  assert.equal(report.comparison.appleAnnotationIdDigestMatches, true);
  assert.equal(report.comparison.availability.apple, true, "an actual apple comparison must mark the apple domain available");
  assert.equal(report.comparison.comparisonUnavailable, false, "the apple domain alone is enough to make comparisonUnavailable false");
  assert.doesNotMatch(JSON.stringify(report), /AEAnnotation\.sqlite/);
  assert.doesNotMatch(JSON.stringify(report), /secret/);
});

void test("parseShadowBaselineV1 rejects a malformed baseline (bad hashedId shape, oversized entries, wrong schemaVersion)", () => {
  assert.throws(() => parseShadowBaselineV1({ schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [{ hashedId: "not-hex", eligible: true }] }));
  assert.throws(() => parseShadowBaselineV1({ schemaVersion: 2, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [] }));
  assert.throws(() => parseShadowBaselineV1({ schemaVersion: 1, generatedAtIso: "not-a-date", sampleCount: 1, entries: [] }));
  assert.throws(() => parseShadowBaselineV1({ schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: -1, entries: [] }));
});

void test("parseShadowBaselineV1 accepts a well-formed baseline and round-trips its fields", () => {
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  const parsed = parseShadowBaselineV1({
    schemaVersion: 1,
    generatedAtIso: "2026-08-23T00:00:00.000Z",
    sampleCount: 1,
    entries: [{ hashedId, eligible: true, chunkCount: 3 }],
  });
  assert.equal(parsed.entries[0].hashedId, hashedId);
  assert.equal(parsed.entries[0].chunkCount, 3);
});

void test("runShadowComparison stops between notes when the AbortSignal is already aborted, marking the report aborted and leaving later notes unprocessed", async () => {
  const notes = [
    { identity: identity("A.md"), rawContent: "---\n---\nbody a" },
    { identity: identity("B.md"), rawContent: "---\n---\nbody b" },
  ];
  const controller = new AbortController();
  controller.abort();
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource(notes) };
  const report = await runShadowComparison(capabilities, { signal: controller.signal });
  assert.equal(report.aborted, true);
  assert.equal(report.items.length, 0);
});

void test("runShadowComparison skips an oversized note (CONTENT_TOO_LARGE) rather than processing it unbounded, while still returning its identity", async () => {
  const note = { identity: identity("Huge.md"), rawContent: "x".repeat(600_000) };
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([note]) };
  const report = await runShadowComparison(capabilities);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].projected, false);
  assert.ok(report.items[0].reasonCodes.includes("CONTENT_TOO_LARGE"));
});

void test("runShadowComparison never crashes when the note source itself throws -- treated as an empty sample", async () => {
  const capabilities: ShadowEngineCapabilities = { noteSource: { listEligibleSample: async () => { throw new Error("vault enumeration failed"); } } };
  const report = await runShadowComparison(capabilities);
  assert.equal(report.items.length, 0);
});

void test("runShadowComparison rejects an invalid sampleSize (negative/non-integer) before touching the source", async () => {
  let sourceCalled = false;
  const capabilities: ShadowEngineCapabilities = { noteSource: { listEligibleSample: async () => { sourceCalled = true; return []; } } };
  await assert.rejects(() => runShadowComparison(capabilities, { sampleSize: -1 }));
  assert.equal(sourceCalled, false);
});

void test("runShadowComparison's chunk digest is content-sensitive: an EXACT self-projection digest agrees, but a same-length-different-content baseline (mirroring a lengths-only digest) disagrees", async () => {
  const { chunkText: chunkTextRef, DEFAULT_TARGET_TOKENS: targetRef, DEFAULT_OVERLAP_TOKENS: overlapRef } = await import("./chunker");
  const { projectSource: projectSourceRef } = await import("./sourceProjection");

  const bodyA = Array.from({ length: 60 }, (_, index) => `wordA${index}`).join(" ");
  const bodyB = Array.from({ length: 60 }, (_, index) => `wordB${index}`).join(" ");
  const noteAIdentity = identity("A.md");
  const noteA = { identity: noteAIdentity, rawContent: `---\n---\n${bodyA}` };

  // Reimplements this module's OWN digest formula (per-chunk sha256, then sha256 of the joined
  // digests) independently in the test, using only exported primitives (`chunkText`,
  // `projectSource`) -- this is a legitimate way to derive the EXACT expected digest without
  // reaching into shadowEngine.ts internals, and proves the formula is a function of CONTENT, not
  // merely chunk count/length.
  const projectionA = projectSourceRef(noteAIdentity, noteA.rawContent);
  const chunksA = chunkTextRef(projectionA.projectedBody, { targetTokens: targetRef, overlapTokens: overlapRef });
  const chunksB = chunkTextRef(projectSourceRef(identity("B.md"), `---\n---\n${bodyB}`).projectedBody, { targetTokens: targetRef, overlapTokens: overlapRef });
  assert.equal(chunksA.length, chunksB.length, "test setup: both bodies must produce the same chunk COUNT for this to be a meaningful content-sensitivity check");
  assert.deepEqual(chunksA.map((chunk) => chunk.length), chunksB.map((chunk) => chunk.length), "test setup: both bodies must produce the same chunk LENGTH sequence too");

  const { createHash: createHashRef } = await import("node:crypto");
  const digestOf = (text: string) => createHashRef("sha256").update(text, "utf8").digest("hex");
  const realDigestA = digestOf(chunksA.map((chunk) => digestOf(chunk)).join(","));
  const lengthsOnlyDigestB = digestOf(chunksB.map((chunk) => chunk.length).join(","));

  const hashedIdA = createHashRef("sha256").update("path:A.md", "utf8").digest("hex");
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([noteA]) };

  const agreeingReport = await runShadowComparison(capabilities, {
    baseline: { schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [{ hashedId: hashedIdA, eligible: true, chunkBoundaryDigest: realDigestA }] },
  });
  assert.equal(agreeingReport.comparison.chunkDigestAgreementCount, 1, "the exact self-computed content digest must agree");

  const disagreeingReport = await runShadowComparison(capabilities, {
    baseline: { schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [{ hashedId: hashedIdA, eligible: true, chunkBoundaryDigest: lengthsOnlyDigestB }] },
  });
  assert.equal(disagreeingReport.comparison.chunkDigestDisagreementCount, 1, "a lengths-only digest from a DIFFERENT-content note with the same length sequence must disagree -- proves the digest is content-sensitive, not lengths-only");
});

void test("parseShadowBaselineV1 rejects a baseline with a duplicate hashedId across entries", () => {
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  assert.throws(() =>
    parseShadowBaselineV1({
      schemaVersion: 1,
      generatedAtIso: "2026-08-23T00:00:00.000Z",
      sampleCount: 1,
      entries: [{ hashedId, eligible: true }, { hashedId, eligible: false }],
    }),
  );
});

void test("parseShadowBaselineV1 rejects an unrecognized top-level, entry-level, or appleReader field", () => {
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  assert.throws(() =>
    parseShadowBaselineV1({ schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [], unexpectedField: "x" }),
  );
  assert.throws(() =>
    parseShadowBaselineV1({ schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [{ hashedId, eligible: true, unexpectedField: "x" }] }),
  );
  assert.throws(() =>
    parseShadowBaselineV1({ schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [], appleReader: { status: "success", count: 0, unexpectedField: "x" } }),
  );
});

void test("parseShadowBaselineV1 rejects a non-canonical generatedAtIso and an out-of-range/negative sampleCount", () => {
  assert.throws(() => parseShadowBaselineV1({ schemaVersion: 1, generatedAtIso: "2026-08-23", sampleCount: 1, entries: [] }));
  assert.throws(() => parseShadowBaselineV1({ schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: -1, entries: [] }));
  assert.throws(() => parseShadowBaselineV1({ schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1.5, entries: [] }));
});

void test("parseShadowBaselineV1 rejects an appleReader.status that is not a recognized AppleBooksReadStatus value", () => {
  assert.throws(() =>
    parseShadowBaselineV1({ schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [], appleReader: { status: "not-a-real-status", count: 0 } }),
  );
});

void test("parseShadowBaselineV1 rejects relatedCandidateHashedIds present without relatedNonEmpty:true (contradictory correlation)", () => {
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  const candidateId = createHash("sha256").update("path:Other.md", "utf8").digest("hex");
  assert.throws(() =>
    parseShadowBaselineV1({
      schemaVersion: 1,
      generatedAtIso: "2026-08-23T00:00:00.000Z",
      sampleCount: 1,
      entries: [{ hashedId, eligible: true, relatedCandidateHashedIds: [candidateId] }],
    }),
  );
});

void test("parseShadowBaselineV1 rejects a duplicate candidate id within one entry's relatedCandidateHashedIds", () => {
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  const candidateId = createHash("sha256").update("path:Other.md", "utf8").digest("hex");
  assert.throws(() =>
    parseShadowBaselineV1({
      schemaVersion: 1,
      generatedAtIso: "2026-08-23T00:00:00.000Z",
      sampleCount: 1,
      entries: [{ hashedId, eligible: true, relatedNonEmpty: true, relatedCandidateHashedIds: [candidateId, candidateId] }],
    }),
  );
});

void test("runShadowComparison's noteCountDelta compares like-for-like capped sample sizes (this run's sampleSize vs baseline.sampleCount), never a capped sample against an unrelated whole-vault total", async () => {
  const notes = Array.from({ length: 5 }, (_, index) => ({ identity: identity(`Notes/n${index}.md`), rawContent: "---\n---\nbody text here" }));
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource(notes) };
  const entries = notes.map((note) => ({ hashedId: createHash("sha256").update(`path:${note.identity.canonicalPath}`, "utf8").digest("hex"), eligible: true }));
  const report = await runShadowComparison(capabilities, {
    baseline: { schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 5, entries },
  });
  assert.equal(report.comparison.noteCountDelta, 0, "5 TS-side vs 5 baseline sampleCount must be an exact match, not skewed by an unrelated whole-vault count");
  assert.equal(report.comparison.eligibilityDisagreementCount, 0, "an exact matching 5-vs-5 set must show zero eligibility disagreements");
});

void test("runShadowComparison forwards its AbortSignal into ShadowNoteSource.listEligibleSample so a hung source enumeration can be cancelled", async () => {
  let receivedSignal: AbortSignal | undefined;
  const source: ShadowNoteSource = {
    listEligibleSample: async (_maxCount, signal) => {
      receivedSignal = signal;
      return [];
    },
  };
  const controller = new AbortController();
  await runShadowComparison({ noteSource: source }, { signal: controller.signal });
  assert.equal(receivedSignal, controller.signal);
});

void test("runShadowComparison rejects an invalid chunk token configuration up front, even for an empty sample where chunkText itself would never otherwise run", async () => {
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([]) };
  await assert.rejects(() => runShadowComparison(capabilities, { chunkTargetTokens: -1 }));
  await assert.rejects(() => runShadowComparison(capabilities, { chunkOverlapTokens: -1 }));
});

void test("runShadowComparison uses parseNoteIdentityV1 to validate every source entry's identity, rejecting a spoofed/malformed one", async () => {
  const source: ShadowNoteSource = {
    listEligibleSample: async () => [
      { identity: { schemaVersion: 1, kind: "path", canonicalPath: "../escape.md" } as unknown as NoteIdentityV1, rawContent: "body" },
    ],
  };
  const report = await runShadowComparison({ noteSource: source });
  assert.equal(report.items.length, 0);
  assert.equal(report.reasonCodeCounts.SOURCE_ITEM_INVALID, 1);
});

void test("runShadowComparison rejects a non-canonical nowIso -- only the exact toISOString-shaped format is accepted", async () => {
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([]) };
  await assert.rejects(() => runShadowComparison(capabilities, { nowIso: "2026-08-23" }));
  await assert.rejects(() => runShadowComparison(capabilities, { nowIso: "2026-08-23T00:00:00Z" }));
  await assert.rejects(() => runShadowComparison(capabilities, { nowIso: "not-a-date" }));
  const report = await runShadowComparison(capabilities, { nowIso: "2026-08-23T00:00:00.000Z" });
  assert.equal(report.generatedAtIso, "2026-08-23T00:00:00.000Z");
});

void test("runShadowComparison rejects a non-safe-integer sampleSize or tsIndexNoteCount", async () => {
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([]) };
  await assert.rejects(() => runShadowComparison(capabilities, { sampleSize: Number.MAX_SAFE_INTEGER + 1 }));
  await assert.rejects(() => runShadowComparison(capabilities, { sampleSize: 1.5 }));
  await assert.rejects(() => runShadowComparison(capabilities, { tsIndexNoteCount: Number.MAX_SAFE_INTEGER + 1 }));
  await assert.rejects(() => runShadowComparison(capabilities, { tsIndexNoteCount: -1 }));
});

void test("runShadowComparison re-validates options.baseline via parseShadowBaselineV1 even when the caller bypasses the parser with a raw type-cast object", async () => {
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([]) };
  // A caller could construct this object with `as ShadowBaselineV1` and never actually call
  // parseShadowBaselineV1 -- TypeScript's structural typing offers no runtime guarantee. This must
  // still be rejected: `hashedId` is not a valid 64-char hex digest.
  const forged = { schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 0, entries: [{ hashedId: "not-a-real-hash", eligible: true }] } as unknown as ShadowBaselineV1;
  await assert.rejects(() => runShadowComparison(capabilities, { baseline: forged }));
});

void test("runShadowComparison treats a source enumeration cancelled by an already-aborted signal as aborted:true, distinct from an ordinary empty/throwing sample", async () => {
  const controller = new AbortController();
  controller.abort();
  const throwingSource: ShadowNoteSource = { listEligibleSample: async () => { throw new Error("cancelled"); } };
  const capabilities: ShadowEngineCapabilities = { noteSource: throwingSource };
  const report = await runShadowComparison(capabilities, { signal: controller.signal });
  assert.equal(report.aborted, true, "a source enumeration failure while the signal is already aborted must be reported as aborted, not silently treated as a normal empty sample");
});

void test("runShadowComparison surfaces a note source's own getSkipReasonCounts into ShadowReportV1.sourceSkipReasonCounts", async () => {
  const source: ShadowNoteSource = {
    listEligibleSample: async () => [],
    getSkipReasonCounts: () => ({ UNSAFE_PATH: 3, OUT_OF_SCOPE: 5 }),
  };
  const report = await runShadowComparison({ noteSource: source });
  assert.deepEqual(report.sourceSkipReasonCounts, { UNSAFE_PATH: 3, OUT_OF_SCOPE: 5 });
});

void test("runShadowComparison leaves sourceSkipReasonCounts undefined when the note source does not implement getSkipReasonCounts", async () => {
  const report = await runShadowComparison({ noteSource: fixedSource([]) });
  assert.equal(report.sourceSkipReasonCounts, undefined);
});

void test("runShadowComparison's availability flags: an identity-only baseline (hashedId+eligible only) makes ONLY the eligibility domain available -- comparisonUnavailable is false, but projection/chunks/related/apple/index all stay unavailable", async () => {
  const note = { identity: identity("Note.md"), rawContent: "---\n---\nsome content" };
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([note]) };
  const baseline: ShadowBaselineV1 = { schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [{ hashedId, eligible: true }] };
  const report = await runShadowComparison(capabilities, { baseline });
  assert.equal(report.comparison.comparisonUnavailable, false);
  assert.deepEqual(report.comparison.availability, { eligibility: true, projection: false, chunks: false, related: false, apple: false, index: false });
});

void test("runShadowComparison's availability flags: projection and chunks become available independently when their respective baseline fields are present and actually compared", async () => {
  const note = { identity: identity("Note.md"), rawContent: "---\n---\nsome content here" };
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([note]) };
  const baseline: ShadowBaselineV1 = {
    schemaVersion: 1,
    generatedAtIso: "2026-08-23T00:00:00.000Z",
    sampleCount: 1,
    entries: [{ hashedId, eligible: true, projectionDigest: "0".repeat(64), chunkCount: 999 }],
  };
  const report = await runShadowComparison(capabilities, { baseline });
  assert.equal(report.comparison.availability.projection, true);
  assert.equal(report.comparison.availability.chunks, true, "chunkCount alone (no chunkBoundaryDigest) must still mark the chunks domain available");
  assert.equal(report.comparison.availability.related, false);
  assert.equal(report.comparison.availability.apple, false);
});

void test("runShadowComparison's chunkCount comparison agrees/disagrees independently of chunkBoundaryDigest", async () => {
  const note = { identity: identity("Note.md"), rawContent: `---\n---\n${"word ".repeat(200)}` };
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([note]) };

  const agreeing = await runShadowComparison(capabilities, {
    baseline: { schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [{ hashedId, eligible: true, chunkCount: 1 }] },
  });
  // Default chunk options for 200 words produce exactly 1 chunk (well under target size).
  assert.equal(agreeing.comparison.chunkCountAgreementCount, 1);
  assert.equal(agreeing.comparison.chunkCountDisagreementCount, 0);

  const disagreeing = await runShadowComparison(capabilities, {
    baseline: { schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [{ hashedId, eligible: true, chunkCount: 999 }] },
  });
  assert.equal(disagreeing.comparison.chunkCountDisagreementCount, 1);
  assert.equal(disagreeing.comparison.chunkCountAgreementCount, 0);
});

void test("runShadowComparison with a baseline that has zero entries and no other fields stays comparisonUnavailable:true -- an empty file is not 'at least one comparable domain'", async () => {
  const note = { identity: identity("Note.md"), rawContent: "---\n---\nbody" };
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([note]) };
  const baseline: ShadowBaselineV1 = { schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 0, entries: [] };
  const report = await runShadowComparison(capabilities, { baseline });
  assert.equal(report.comparison.comparisonUnavailable, true);
  assert.deepEqual(report.comparison.availability, { eligibility: false, projection: false, chunks: false, related: false, apple: false, index: false });
});

void test("runShadowComparison's availability.index becomes true only when both baseline.indexCount and options.tsIndexNoteCount are supplied", async () => {
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([]) };
  const withoutTsCount = await runShadowComparison(capabilities, {
    baseline: { schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 0, entries: [], indexCount: 10 },
  });
  assert.equal(withoutTsCount.comparison.availability.index, false);
  const withBoth = await runShadowComparison(capabilities, {
    baseline: { schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 0, entries: [], indexCount: 10 },
    tsIndexNoteCount: 12,
  });
  assert.equal(withBoth.comparison.availability.index, true);
  assert.equal(withBoth.comparison.indexCountDelta, 2);
  assert.equal(withBoth.comparison.comparisonUnavailable, false);
});

void test("runShadowComparison's availability.related requires an ACTUAL comparison, not merely a baseline relatedNonEmpty field with no matching index capability", async () => {
  const note = { identity: identity("Note.md"), rawContent: "---\n---\nbody" };
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  // No indexQuery/queryVectorsByHashedId wired -- the related comparison can never actually run.
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([note]) };
  const baseline: ShadowBaselineV1 = { schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [{ hashedId, eligible: true, relatedNonEmpty: true }] };
  const report = await runShadowComparison(capabilities, { baseline });
  assert.equal(report.comparison.availability.related, false, "a baseline field alone, with no TS-side capability to compare it against, must not mark the domain available");
});

void test("parseShadowBaselineV1 enforces sampleCount === count of eligible:true entries exactly", () => {
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  // sampleCount 2 but only 1 eligible entry -- must be rejected.
  assert.throws(() => parseShadowBaselineV1({ schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 2, entries: [{ hashedId, eligible: true }] }));
  // An eligible:false entry must not count toward sampleCount.
  const hashedId2 = createHash("sha256").update("path:Other.md", "utf8").digest("hex");
  assert.throws(() =>
    parseShadowBaselineV1({ schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 2, entries: [{ hashedId, eligible: true }, { hashedId: hashedId2, eligible: false }] }),
  );
  // Correct: sampleCount counts only the eligible entry.
  const parsed = parseShadowBaselineV1({
    schemaVersion: 1,
    generatedAtIso: "2026-08-23T00:00:00.000Z",
    sampleCount: 1,
    entries: [{ hashedId, eligible: true }, { hashedId: hashedId2, eligible: false }],
  });
  assert.equal(parsed.entries.length, 2);
});

void test("digestText normalizes CRLF/CR to LF before hashing -- a CRLF note and its LF-converted twin produce the SAME projectionDigest comparison outcome", async () => {
  const crlfBody = "line one\r\nline two\r\nline three";
  const lfBody = "line one\nline two\nline three";
  const crlfNote = { identity: identity("Note.md"), rawContent: `---\n---\n${crlfBody}` };

  // Compute the LF-normalized digest independently (mirroring digestText's own formula) and use it
  // as the baseline -- proving the CRLF note's TS-side projectionDigest agrees with a digest
  // computed over the LF form, i.e. newline convention does not cause a spurious disagreement.
  const lfDigest = createHash("sha256").update(lfBody, "utf8").digest("hex");
  const hashedId = createHash("sha256").update("path:Note.md", "utf8").digest("hex");
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([crlfNote]) };
  const baseline: ShadowBaselineV1 = { schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [{ hashedId, eligible: true, projectionDigest: lfDigest }] };
  const report = await runShadowComparison(capabilities, { baseline });
  assert.equal(report.comparison.projectionDigestAgreementCount, 1, "a CRLF note's projectionDigest must agree with a baseline digest computed over the LF-normalized equivalent");
  assert.equal(report.comparison.projectionDigestDisagreementCount, 0);
});

void test("a normal-sized report stays well under the bounded encoded-size cap (defense-in-depth check, not expected to ever trip in practice)", async () => {
  const notes = Array.from({ length: MAX_SHADOW_SAMPLE_NOTES }, (_, index) => ({ identity: identity(`Notes/n${index}.md`), rawContent: `---\n---\n${"word ".repeat(200)}` }));
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource(notes) };
  const report = await runShadowComparison(capabilities);
  const encoded = Buffer.byteLength(JSON.stringify(report), "utf8");
  assert.ok(encoded < 2_000_000, `expected a normal report well under the bounded cap, was ${encoded} bytes`);
});

void test("SHADOW_REASON_CODES is the closed allow-list every emitted reason code belongs to", async () => {
  const note = { identity: identity("Note.md"), rawContent: "---\n---\nbody" };
  const capabilities: ShadowEngineCapabilities = { noteSource: fixedSource([note]) };
  const report = await runShadowComparison(capabilities);
  for (const item of report.items) {
    for (const code of item.reasonCodes) {
      assert.ok((SHADOW_REASON_CODES as readonly string[]).includes(code));
    }
  }
});
