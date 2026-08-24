import test from "node:test";
import assert from "node:assert/strict";

import { companionPathForAnnotation } from "../readingResearchCompanion";
import type { NoteVaultAdapter } from "./noteWriter";
import { renderResearchCompanionNote, writeResearchCompanionNote } from "./researchCompanionWriter";

const ANNOTATION_PATH = "Books/Apple Books/Author/Book/Annotations/Quote.md";
const CANDIDATE_0 = companionPathForAnnotation(ANNOTATION_PATH, 0);
const CANDIDATE_1 = companionPathForAnnotation(ANNOTATION_PATH, 1);

class FakeVault implements NoteVaultAdapter {
  files = new Map<string, string>();
  folders = new Set<string>();
  writeCount = 0;
  createCount = 0;
  unreadablePaths = new Set<string>();
  /** When set for a path, the next create() call for that path first injects this content (simulating a concurrent writer winning the race) then rejects as "already exists" -- a deterministic create-race regression harness. */
  raceInjection = new Map<string, string>();

  async read(path: string): Promise<string | null> {
    if (this.unreadablePaths.has(path)) {
      throw new Error("injected unreadable-occupant failure");
    }
    return this.files.get(path) ?? null;
  }

  async modify(path: string, content: string): Promise<void> {
    this.writeCount += 1;
    this.files.set(path, content);
  }

  async create(path: string, content: string): Promise<void> {
    const injected = this.raceInjection.get(path);
    if (injected !== undefined) {
      this.raceInjection.delete(path);
      this.files.set(path, injected);
      throw new Error(`lost create race: ${path}`);
    }
    if (this.files.has(path)) {
      throw new Error(`already exists: ${path}`);
    }
    this.createCount += 1;
    this.files.set(path, content);
  }

  async ensureFolder(path: string): Promise<void> {
    this.folders.add(path);
  }
}

void test("writeResearchCompanionNote creates a new companion note and ensures every ancestor folder from the top-level segment", async () => {
  const vault = new FakeVault();
  const result = await writeResearchCompanionNote(vault, {
    annotationPath: ANNOTATION_PATH,
    annotationId: "annotation-1",
    content: "## Research\nSome findings.",
  });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, CANDIDATE_0);
  assert.match(vault.files.get(result.companionPath)!, /type: mindmap-reading-research/);
  assert.match(vault.files.get(result.companionPath)!, /annotation_id: annotation-1/);
  assert.deepEqual(
    [...vault.folders].sort(),
    ["Books", "Books/Apple Books", "Books/Apple Books/Author", "Books/Apple Books/Author/Book", "Books/Apple Books/Author/Book/Research"].sort(),
    "every ancestor folder must be ensured, starting from the top-level segment, not just the immediate parent",
  );
});

void test("writeResearchCompanionNote is idempotent: an unchanged second write reports unchanged and does not touch the vault", async () => {
  const vault = new FakeVault();
  const options = { annotationPath: ANNOTATION_PATH, annotationId: "annotation-1", content: "## Research\nSome findings." };
  const first = await writeResearchCompanionNote(vault, options);
  assert.equal(vault.createCount, 1);
  const second = await writeResearchCompanionNote(vault, options);
  assert.equal(second.action, "unchanged");
  assert.equal(second.companionPath, first.companionPath);
  assert.equal(vault.createCount, 1);
  assert.equal(vault.writeCount, 0, "an unchanged note must never call modify()");
});

void test("writeResearchCompanionNote updates an existing companion note for the same annotation when content changes", async () => {
  const vault = new FakeVault();
  const options = { annotationPath: ANNOTATION_PATH, annotationId: "annotation-1", content: "## Research\nOld findings." };
  const first = await writeResearchCompanionNote(vault, options);
  const second = await writeResearchCompanionNote(vault, { ...options, content: "## Research\nNew findings." });
  assert.equal(second.action, "updated");
  assert.equal(second.companionPath, first.companionPath);
  assert.match(vault.files.get(second.companionPath)!, /New findings/);
});

void test("writeResearchCompanionNote skips a foreign note occupying the candidate path and falls through to a collision-numbered path", async () => {
  const vault = new FakeVault();
  vault.files.set(CANDIDATE_0, "---\ntype: mindmap-reading-research\nannotation_id: someone-elses\n---\nUnrelated.\n");
  const result = await writeResearchCompanionNote(vault, {
    annotationPath: ANNOTATION_PATH,
    annotationId: "annotation-1",
    content: "## Research\nFindings.",
  });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, CANDIDATE_1);
});

void test("writeResearchCompanionNote skips an unreadable occupant (permission error) without overwriting it, and never treats it as missing", async () => {
  const vault = new FakeVault();
  vault.unreadablePaths.add(CANDIDATE_0);
  const result = await writeResearchCompanionNote(vault, {
    annotationPath: ANNOTATION_PATH,
    annotationId: "annotation-1",
    content: "## Research\nFindings.",
  });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, CANDIDATE_1);
  assert.equal(vault.files.has(CANDIDATE_0), false, "the unreadable occupant must never be written to");
});

void test("writeResearchCompanionNote reuses a storedCompanionPath when it is a genuine candidate and its annotation_id still matches", async () => {
  const vault = new FakeVault();
  const stored = CANDIDATE_1;
  vault.files.set(stored, renderResearchCompanionNote(ANNOTATION_PATH, "annotation-1", "Old."));
  const result = await writeResearchCompanionNote(vault, {
    annotationPath: ANNOTATION_PATH,
    annotationId: "annotation-1",
    content: "New.",
    storedCompanionPath: stored,
  });
  assert.equal(result.companionPath, stored);
  assert.equal(result.action, "updated");
});

void test("writeResearchCompanionNote ignores a malicious storedCompanionPath that is not one of companionPathForAnnotation's own candidates", async () => {
  const vault = new FakeVault();
  const maliciousStored = "Books/Apple Books/Author/Book/Research/../../../etc/passwd.md";
  vault.files.set(maliciousStored, "malicious content, must never be touched");
  const result = await writeResearchCompanionNote(vault, {
    annotationPath: ANNOTATION_PATH,
    annotationId: "annotation-1",
    content: "## Research\nFindings.",
    storedCompanionPath: maliciousStored,
  });
  assert.equal(result.companionPath, CANDIDATE_0, "must fall back to the real candidate sequence, ignoring the untrusted stored path");
  assert.equal(vault.files.get(maliciousStored), "malicious content, must never be touched");
});

void test("writeResearchCompanionNote ignores a storedCompanionPath outside this annotation's own Research folder", async () => {
  const vault = new FakeVault();
  const foreignStored = "Books/Apple Books/Other Author/Other Book/Research/Quote.md";
  vault.files.set(foreignStored, renderResearchCompanionNote(ANNOTATION_PATH, "annotation-1", "Should not be reused."));
  const result = await writeResearchCompanionNote(vault, {
    annotationPath: ANNOTATION_PATH,
    annotationId: "annotation-1",
    content: "## Research\nFindings.",
    storedCompanionPath: foreignStored,
  });
  assert.equal(result.companionPath, CANDIDATE_0);
});

void test("writeResearchCompanionNote rejects an invalid (non-6-segment) annotation source path", async () => {
  const vault = new FakeVault();
  await assert.rejects(() =>
    writeResearchCompanionNote(vault, {
      annotationPath: "Books/Apple Books/Author/Annotations/Quote.md",
      annotationId: "annotation-1",
      content: "## Research\nFindings.",
    }),
  );
});

void test("writeResearchCompanionNote rejects an annotation source path with a traversal segment", async () => {
  const vault = new FakeVault();
  await assert.rejects(() =>
    writeResearchCompanionNote(vault, {
      annotationPath: "Books/Apple Books/Author/Book/Annotations/../../../etc/passwd.md",
      annotationId: "annotation-1",
      content: "## Research\nFindings.",
    }),
  );
});

void test("writeResearchCompanionNote rejects a blank annotation_id", async () => {
  const vault = new FakeVault();
  await assert.rejects(() =>
    writeResearchCompanionNote(vault, { annotationPath: ANNOTATION_PATH, annotationId: "   ", content: "## Research\nFindings." }),
  );
});

void test("writeResearchCompanionNote rejects an annotation_id containing a wikilink delimiter", async () => {
  const vault = new FakeVault();
  await assert.rejects(() =>
    writeResearchCompanionNote(vault, { annotationPath: ANNOTATION_PATH, annotationId: "bad|id", content: "## Research\nFindings." }),
  );
});

void test("renderResearchCompanionNote quotes and round-trips a YAML-special annotation_id (colon, purely numeric) via the YAML Document API", () => {
  const rendered = renderResearchCompanionNote(ANNOTATION_PATH, "12345", "Findings.");
  assert.match(rendered, /annotation_id: '12345'/);

  const withColon = renderResearchCompanionNote(ANNOTATION_PATH, "id: with-colon", "Findings.");
  assert.match(withColon, /annotation_id: 'id: with-colon'/);
});

void test("writeResearchCompanionNote round-trips a YAML-special (purely numeric) annotation_id through create-then-match", async () => {
  const vault = new FakeVault();
  const first = await writeResearchCompanionNote(vault, { annotationPath: ANNOTATION_PATH, annotationId: "12345", content: "Findings." });
  assert.equal(first.action, "created");
  const second = await writeResearchCompanionNote(vault, { annotationPath: ANNOTATION_PATH, annotationId: "12345", content: "Findings." });
  assert.equal(second.action, "unchanged");
  assert.equal(second.companionPath, first.companionPath);
});

void test("writeResearchCompanionNote wraps a modify() failure (updating an existing matching companion) as a structured EngineError without leaking the adapter's raw error text", async () => {
  const vault = new FakeVault();
  vault.files.set(CANDIDATE_0, renderResearchCompanionNote(ANNOTATION_PATH, "annotation-1", "Old."));
  const secretMessage = "SECRET-INTERNAL-DETAIL";
  vault.modify = async () => {
    throw new Error(secretMessage);
  };
  try {
    await writeResearchCompanionNote(vault, { annotationPath: ANNOTATION_PATH, annotationId: "annotation-1", content: "New findings." });
    assert.fail("expected a rejection");
  } catch (error) {
    assert.equal((error as { code?: string }).code, "VAULT_WRITE_FAILED");
    assert.doesNotMatch(JSON.stringify(error), new RegExp(secretMessage));
    assert.doesNotMatch((error as Error).message, /SECRET-INTERNAL/);
  }
});

void test("writeResearchCompanionNote wraps a genuine (non-race) create() failure as a structured EngineError without leaking the adapter's raw error text", async () => {
  const vault = new FakeVault();
  const secretMessage = "SECRET-INTERNAL-DETAIL";
  vault.create = async () => {
    throw new Error(secretMessage);
  };
  try {
    await writeResearchCompanionNote(vault, { annotationPath: ANNOTATION_PATH, annotationId: "annotation-1", content: "Findings." });
    assert.fail("expected a rejection");
  } catch (error) {
    assert.equal((error as { code?: string }).code, "VAULT_WRITE_FAILED");
    assert.doesNotMatch(JSON.stringify(error), new RegExp(secretMessage));
    assert.doesNotMatch((error as Error).message, /SECRET-INTERNAL/);
  }
});

void test("writeResearchCompanionNote exhausts bounded collision attempts and fails closed rather than looping forever", async () => {
  const vault = new FakeVault();
  for (let i = 0; i < 3; i += 1) {
    const candidate = companionPathForAnnotation(ANNOTATION_PATH, i);
    vault.files.set(candidate, `---\ntype: mindmap-reading-research\nannotation_id: someone-elses-${i}\n---\nUnrelated.\n`);
  }
  await assert.rejects(
    () =>
      writeResearchCompanionNote(vault, {
        annotationPath: ANNOTATION_PATH,
        annotationId: "annotation-1",
        content: "Findings.",
        maxCollisionAttempts: 3,
      }),
    (error: unknown) => (error as { code?: string }).code === "VAULT_WRITE_FAILED",
  );
});

void test("writeResearchCompanionNote adopts a race winner that wrote the same annotation_id instead of overwriting it via create", async () => {
  const vault = new FakeVault();
  const winnerText = renderResearchCompanionNote(ANNOTATION_PATH, "annotation-1", "Findings.");
  vault.raceInjection.set(CANDIDATE_0, winnerText);
  const result = await writeResearchCompanionNote(vault, { annotationPath: ANNOTATION_PATH, annotationId: "annotation-1", content: "Findings." });
  assert.equal(result.action, "unchanged");
  assert.equal(result.companionPath, CANDIDATE_0);
  assert.equal(vault.files.get(CANDIDATE_0), winnerText);
  assert.equal(vault.createCount, 0, "the lost race means create() never actually committed this writer's own content");
});

void test("writeResearchCompanionNote updates a race winner that wrote the same annotation_id but different content", async () => {
  const vault = new FakeVault();
  const winnerText = renderResearchCompanionNote(ANNOTATION_PATH, "annotation-1", "Winner's findings.");
  vault.raceInjection.set(CANDIDATE_0, winnerText);
  const result = await writeResearchCompanionNote(vault, { annotationPath: ANNOTATION_PATH, annotationId: "annotation-1", content: "My findings." });
  assert.equal(result.action, "updated");
  assert.equal(result.companionPath, CANDIDATE_0);
  assert.match(vault.files.get(CANDIDATE_0)!, /My findings\./);
});

void test("writeResearchCompanionNote never overwrites a race winner with an unrelated annotation_id, and moves to the next candidate", async () => {
  const vault = new FakeVault();
  const foreignText = "---\ntype: mindmap-reading-research\nannotation_id: someone-elses\n---\nForeign content.\n";
  vault.raceInjection.set(CANDIDATE_0, foreignText);
  const result = await writeResearchCompanionNote(vault, { annotationPath: ANNOTATION_PATH, annotationId: "annotation-1", content: "My findings." });
  assert.equal(result.action, "created");
  assert.equal(result.companionPath, CANDIDATE_1);
  assert.equal(vault.files.get(CANDIDATE_0), foreignText, "the foreign race winner's content must survive completely untouched");
});

void test("writeResearchCompanionNote rejects maxCollisionAttempts of zero without any vault read", async () => {
  const vault = new FakeVault();
  await assert.rejects(
    () =>
      writeResearchCompanionNote(vault, { annotationPath: ANNOTATION_PATH, annotationId: "annotation-1", content: "Findings.", maxCollisionAttempts: 0 }),
    (error: unknown) => (error as { code?: string }).code === "CONTRACT_SHAPE_INVALID",
  );
  assert.equal(vault.files.size, 0);
});

void test("writeResearchCompanionNote rejects a negative maxCollisionAttempts", async () => {
  const vault = new FakeVault();
  await assert.rejects(
    () =>
      writeResearchCompanionNote(vault, { annotationPath: ANNOTATION_PATH, annotationId: "annotation-1", content: "Findings.", maxCollisionAttempts: -1 }),
    (error: unknown) => (error as { code?: string }).code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("writeResearchCompanionNote rejects a fractional maxCollisionAttempts", async () => {
  const vault = new FakeVault();
  await assert.rejects(
    () =>
      writeResearchCompanionNote(vault, { annotationPath: ANNOTATION_PATH, annotationId: "annotation-1", content: "Findings.", maxCollisionAttempts: 2.5 }),
    (error: unknown) => (error as { code?: string }).code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("writeResearchCompanionNote rejects NaN and Infinity for maxCollisionAttempts", async () => {
  const vault = new FakeVault();
  await assert.rejects(
    () =>
      writeResearchCompanionNote(vault, {
        annotationPath: ANNOTATION_PATH,
        annotationId: "annotation-1",
        content: "Findings.",
        maxCollisionAttempts: Number.NaN,
      }),
    (error: unknown) => (error as { code?: string }).code === "CONTRACT_SHAPE_INVALID",
  );
  await assert.rejects(
    () =>
      writeResearchCompanionNote(vault, {
        annotationPath: ANNOTATION_PATH,
        annotationId: "annotation-1",
        content: "Findings.",
        maxCollisionAttempts: Number.POSITIVE_INFINITY,
      }),
    (error: unknown) => (error as { code?: string }).code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("writeResearchCompanionNote rejects a maxCollisionAttempts above the hard 100 ceiling", async () => {
  const vault = new FakeVault();
  await assert.rejects(
    () =>
      writeResearchCompanionNote(vault, {
        annotationPath: ANNOTATION_PATH,
        annotationId: "annotation-1",
        content: "Findings.",
        maxCollisionAttempts: 101,
      }),
    (error: unknown) => (error as { code?: string }).code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("writeResearchCompanionNote accepts maxCollisionAttempts exactly at the 100 ceiling", async () => {
  const vault = new FakeVault();
  const result = await writeResearchCompanionNote(vault, {
    annotationPath: ANNOTATION_PATH,
    annotationId: "annotation-1",
    content: "Findings.",
    maxCollisionAttempts: 100,
  });
  assert.equal(result.action, "created");
});
