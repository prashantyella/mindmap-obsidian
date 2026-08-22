import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { validateAppleBooksReaderPayload } from "../readingTypes";
import {
  buildAppleBooksFixture,
  cleanupFixtureRoot,
  makeFixtureRoot,
} from "./appleBooksFixtureBuilder.test-support";
import {
  AppleBooksConfigurationError,
  AppleBooksSqliteReader,
  createNodeAppleBooksFsAdapter,
  isUsableAppleBooksPayload,
  MAX_SNAPSHOT_RETRIES,
  MIN_SNAPSHOT_RETRIES,
  type AppleBooksFsAdapter,
} from "./appleBooksSqlite";
import { createNodeSqliteProcess, SQLITE_BINARY_PATH, SqliteProcessError, type SqliteProcess, type SqliteRunOptions, type SqliteRunResult } from "./sqliteProcess";

const execFileP = promisify(execFile);

function makeReader(overrides: Partial<ConstructorParameters<typeof AppleBooksSqliteReader>[0]> & { annotationDbPath: string }) {
  return new AppleBooksSqliteReader({
    sqliteProcess: createNodeSqliteProcess(),
    fs: createNodeAppleBooksFsAdapter(),
    config: {},
    homeDirectory: overrides.annotationDbPath,
    ...overrides,
  });
}

async function withFixtureRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await makeFixtureRoot();
  try {
    return await fn(root);
  } finally {
    await cleanupFixtureRoot(root);
  }
}

// ---------------------------------------------------------------------------
// Supported/partial/malformed/versioned schemas, direct-mode success
// ---------------------------------------------------------------------------

void test("readAnnotations: joined schema normalizes annotation and book title metadata, skips the tombstone row", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath } = await buildAppleBooksFixture(root, "joined");
    const before = await fs.readFile(annotationPath);
    const result = await makeReader({ annotationDbPath: annotationPath }).readAnnotations();
    assert.equal(result.status, "success");
    assert.equal(result.count, 1);
    const [item] = result.annotations;
    assert.equal(item.annotation_id, "aeannotation:uuid-1");
    assert.equal(item.quote, "A useful highlighted passage.");
    assert.equal(item.user_note, "A personal note.");
    assert.equal(item.book_title, "The Quiet Book");
    assert.equal(item.author, "A. Reader");
    assert.equal(item.chapter, "Chapter One");
    assert.equal(item.location, "42");
    assert.ok(item.created_at?.endsWith("Z"));
    assert.ok(item.modified_at?.endsWith("Z"));
    assert.deepEqual(await fs.readFile(annotationPath), before, "the source database must never be mutated");
    assert.ok(isUsableAppleBooksPayload(result));
    assert.doesNotThrow(() => validateAppleBooksReaderPayload(result));
  }));

void test("readAnnotations: asset-enriched schema pulls title/author from the library database by asset ID", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath, libraryPath } = await buildAppleBooksFixture(root, "asset-enriched");
    const result = await makeReader({ annotationDbPath: annotationPath, libraryDbPath: libraryPath }).readAnnotations();
    assert.equal(result.status, "success");
    assert.equal(result.count, 1);
    const [item] = result.annotations;
    assert.equal(item.book_title, "The Other Book");
    assert.equal(item.author, "B. Writer");
    assert.equal(item.location, "88");
    assert.deepEqual(new Set((result.sources ?? []).map((s) => s.role)), new Set(["annotations", "library"]));
  }));

void test("readAnnotations: an unsupported schema returns a structured, actionable diagnostic", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath } = await buildAppleBooksFixture(root, "unsupported");
    const result = await makeReader({ annotationDbPath: annotationPath }).readAnnotations();
    assert.equal(result.status, "unsupported_schema");
    assert.equal(result.diagnostics[0]?.code, "APPLE_BOOKS_SCHEMA_UNSUPPORTED");
  }));

void test("readAnnotations: malformed rows are all-skipped -> malformed_rows with zero usable annotations", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath } = await buildAppleBooksFixture(root, "joined", { malformed: true });
    const result = await makeReader({ annotationDbPath: annotationPath }).readAnnotations();
    assert.equal(result.status, "malformed_rows");
    assert.equal(result.count, 0);
    assert.equal(result.skipped_rows, 1);
    assert.equal(
      result.diagnostics[0]?.guidance,
      "Valid annotations remain usable. Retry after Apple Books finishes updating; if the issue persists, report an unsupported schema.",
    );
  }));

void test("readAnnotations: some malformed rows are partial -> usable annotations survive alongside a warning", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath } = await buildAppleBooksFixture(root, "joined", { partial: true });
    const result = await makeReader({ annotationDbPath: annotationPath }).readAnnotations();
    assert.equal(result.status, "partial");
    assert.equal(result.count, 1);
    assert.equal(result.skipped_rows, 1);
    assert.ok(isUsableAppleBooksPayload(result));
  }));

void test("readAnnotations: an empty annotation table is success with zero annotations", () =>
  withFixtureRoot(async (root) => {
    const dbPath = path.join(root, "AEAnnotation.sqlite");
    await execFileP(SQLITE_BINARY_PATH, [dbPath, "CREATE TABLE ZAEANNOTATION (Z_PK INTEGER PRIMARY KEY, ZANNOTATIONSELECTEDTEXT TEXT)"]);
    const result = await makeReader({ annotationDbPath: dbPath }).readAnnotations();
    assert.equal(result.status, "success");
    assert.equal(result.count, 0);
    assert.deepEqual(result.annotations, []);
  }));

void test("readAnnotations: a missing database returns unavailable without exposing its path in the result", () =>
  withFixtureRoot(async (root) => {
    const missing = path.join(root, "secret-subdir", "AEAnnotation.sqlite");
    const result = await makeReader({ annotationDbPath: missing }).readAnnotations();
    assert.equal(result.status, "unavailable");
    assert.doesNotMatch(JSON.stringify(result), /secret-subdir/);
  }));

void test("uuid identity survives the underlying row id changing", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath } = await buildAppleBooksFixture(root, "joined");
    const first = await makeReader({ annotationDbPath: annotationPath }).readAnnotations();
    await execFileP(SQLITE_BINARY_PATH, [annotationPath, "UPDATE ZAEANNOTATION SET Z_PK = 101 WHERE ZANNOTATIONUUID = 'uuid-1'"]);
    const second = await makeReader({ annotationDbPath: annotationPath }).readAnnotations();
    assert.equal(first.annotations[0]?.annotation_id, "aeannotation:uuid-1");
    assert.equal(second.annotations[0]?.annotation_id, "aeannotation:uuid-1");
  }));

// ---------------------------------------------------------------------------
// WAL / backup fallback, equivalence between direct and backup paths
// ---------------------------------------------------------------------------

void test("readAnnotations: reads committed WAL activity via backup fallback without changing the source", () =>
  withFixtureRoot(async (root) => {
    const dbPath = path.join(root, "AEAnnotation.sqlite");
    await execFileP(SQLITE_BINARY_PATH, [
      dbPath,
      "PRAGMA journal_mode=WAL; CREATE TABLE ZAEANNOTATION (Z_PK INTEGER PRIMARY KEY, ZANNOTATIONUUID TEXT, ZANNOTATIONSELECTEDTEXT TEXT); INSERT INTO ZAEANNOTATION VALUES (1,'uuid-1','WAL passage.');",
    ]);
    const before = { db: await fs.stat(dbPath) };
    const result = await makeReader({ annotationDbPath: dbPath }).readAnnotations();
    const after = { db: await fs.stat(dbPath) };
    assert.equal(result.status, "success");
    assert.equal(result.annotations[0]?.quote, "WAL passage.");
    assert.equal(before.db.size, after.db.size);
    assert.equal(before.db.mtimeMs, after.db.mtimeMs);
  }));

void test("readAnnotations: direct-mode and backup-mode produce equivalent normalized annotation content", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath } = await buildAppleBooksFixture(root, "joined");
    const direct = await makeReader({ annotationDbPath: annotationPath }).readAnnotations();

    // Force the single attempt (snapshotRetries: 1) to look unstable by lying about the main
    // database file's mtime changing between the "before" and "after" stat calls, so the reader
    // immediately exhausts its retry budget and falls through to backup mode.
    const realFs = createNodeAppleBooksFsAdapter();
    let mainDbStatCalls = 0;
    const flakyFs: AppleBooksFsAdapter = {
      ...realFs,
      async probe(filePath: string) {
        const real = await realFs.probe(filePath);
        if (real.kind === "present" && filePath === annotationPath) {
          mainDbStatCalls += 1;
          return { ...real, mtimeMs: real.mtimeMs + mainDbStatCalls };
        }
        return real;
      },
    };
    const backupReader = new AppleBooksSqliteReader({
      sqliteProcess: createNodeSqliteProcess(),
      fs: flakyFs,
      config: {},
      homeDirectory: root,
      annotationDbPath: annotationPath,
      snapshotRetries: 1,
    });
    const backup = await backupReader.readAnnotations();
    assert.equal(backup.status, "success");
    assert.deepEqual(backup.annotations, direct.annotations);
    assert.equal(backup.sources?.[0]?.snapshot, "sqlite-backup-file");
    assert.equal(direct.sources?.[0]?.snapshot, "sqlite-direct");
    assert.equal(backup.sources?.[0]?.filename, direct.sources?.[0]?.filename, "backup-mode source identity must match the original annotation filename");
    assert.equal(backup.sources?.[0]?.filename, "AEAnnotation.sqlite");
    assert.equal(backup.sources?.[0]?.role, direct.sources?.[0]?.role);
    assert.equal(backup.sources?.[0]?.schema, direct.sources?.[0]?.schema);
    assert.equal(backup.sources?.[0]?.wal_present, direct.sources?.[0]?.wal_present, "backup-mode wal_present must reflect the original source, not the fresh temp copy");
  }));

void test("readAnnotations: backup-mode source metadata never exposes the temp backup.sqlite path or filename, for either the annotation or library source", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath, libraryPath } = await buildAppleBooksFixture(root, "asset-enriched");
    const realFs = createNodeAppleBooksFsAdapter();
    let mainDbStatCalls = 0;
    const flakyFs: AppleBooksFsAdapter = {
      ...realFs,
      async probe(filePath: string) {
        const real = await realFs.probe(filePath);
        if (real.kind === "present" && filePath === annotationPath) {
          mainDbStatCalls += 1;
          return { ...real, mtimeMs: real.mtimeMs + mainDbStatCalls };
        }
        return real;
      },
    };
    const reader = new AppleBooksSqliteReader({
      sqliteProcess: createNodeSqliteProcess(),
      fs: flakyFs,
      config: {},
      homeDirectory: root,
      annotationDbPath: annotationPath,
      libraryDbPath: libraryPath,
      snapshotRetries: 1,
    });
    const result = await reader.readAnnotations();
    assert.equal(result.status, "success");
    assert.equal(result.sources?.length, 2);
    const annotationSource = result.sources?.find((s) => s.role === "annotations");
    const librarySource = result.sources?.find((s) => s.role === "library");
    assert.equal(annotationSource?.filename, "AEAnnotation.sqlite");
    assert.equal(librarySource?.filename, "BKLibrary.sqlite");
    assert.equal(annotationSource?.snapshot, "sqlite-backup-file");
    assert.equal(librarySource?.snapshot, "sqlite-backup-file");
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /backup\.sqlite/, "no source metadata may expose the temp backup.sqlite filename");
    assert.doesNotMatch(serialized, /mindmap-apple-books-/, "no source metadata may expose the owned temp directory path");
  }));

void test("readAnnotations: an unstable source retries the bounded number of times before falling back", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath } = await buildAppleBooksFixture(root, "joined");
    const realFs = createNodeAppleBooksFsAdapter();
    let mainDbStatCalls = 0;
    const alwaysUnstableFs: AppleBooksFsAdapter = {
      ...realFs,
      async probe(filePath: string) {
        const real = await realFs.probe(filePath);
        if (real.kind === "present" && filePath === annotationPath) {
          mainDbStatCalls += 1;
          return { ...real, mtimeMs: real.mtimeMs + mainDbStatCalls };
        }
        return real;
      },
    };
    const reader = new AppleBooksSqliteReader({
      sqliteProcess: createNodeSqliteProcess(),
      fs: alwaysUnstableFs,
      config: {},
      homeDirectory: root,
      annotationDbPath: annotationPath,
      snapshotRetries: 3,
    });
    const result = await reader.readAnnotations();
    assert.equal(result.status, "success");
    assert.equal(result.sources?.[0]?.snapshot, "sqlite-backup-file", "must have fallen back to backup mode after exhausting retries");
  }));

void test("readAnnotations: cleans up its own backup temp directory and never leaves it behind", () =>
  withFixtureRoot(async (root) => {
    const dbPath = path.join(root, "AEAnnotation.sqlite");
    await execFileP(SQLITE_BINARY_PATH, [
      dbPath,
      "PRAGMA journal_mode=WAL; CREATE TABLE ZAEANNOTATION (Z_PK INTEGER PRIMARY KEY, ZANNOTATIONUUID TEXT, ZANNOTATIONSELECTEDTEXT TEXT); INSERT INTO ZAEANNOTATION VALUES (1,'uuid-1','WAL passage.');",
    ]);
    const before = await fs.readdir(os.tmpdir());
    await makeReader({ annotationDbPath: dbPath }).readAnnotations();
    const after = await fs.readdir(os.tmpdir());
    const leaked = after.filter((entry) => entry.startsWith("mindmap-apple-books-") && !before.includes(entry));
    assert.deepEqual(leaked, [], "no mindmap-apple-books- temp directory should survive a completed read");
  }));

void test("readAnnotations: cleanup runs even when the backup query itself fails", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath } = await buildAppleBooksFixture(root, "joined");
    const realProcess = createNodeSqliteProcess();
    let backupCount = 0;
    const removedDirs: string[] = [];
    const failingBackupProcess: SqliteProcess = {
      async run(options: SqliteRunOptions): Promise<SqliteRunResult> {
        if (options.script.startsWith(".backup")) {
          backupCount += 1;
          return realProcess.run(options);
        }
        if (!options.extraArgs.includes("-readonly")) {
          throw new Error("simulated backup-query failure");
        }
        return realProcess.run(options);
      },
    };
    const realFs = createNodeAppleBooksFsAdapter();
    const trackingFs: AppleBooksFsAdapter = {
      ...realFs,
      async rmDirRecursive(dirPath: string) {
        removedDirs.push(dirPath);
        await realFs.rmDirRecursive(dirPath);
      },
      async probe(filePath: string) {
        // Force instability so the reader always falls through to backup mode.
        if (filePath.endsWith("-wal")) {
          return { kind: "present", size: 0, mtimeMs: Date.now() + Math.random() };
        }
        return realFs.probe(filePath);
      },
    };
    const reader = new AppleBooksSqliteReader({
      sqliteProcess: failingBackupProcess,
      fs: trackingFs,
      config: {},
      homeDirectory: root,
      annotationDbPath: annotationPath,
      snapshotRetries: 1,
    });
    const result = await reader.readAnnotations();
    assert.notEqual(result.status, "success");
    assert.ok(backupCount >= 1, "the backup dot-command must have actually run");
    assert.ok(removedDirs.some((dir) => dir.includes("mindmap-apple-books-")), "the owned temp dir must still be cleaned up after a failed backup-mode query");
  }));

// ---------------------------------------------------------------------------
// Payload shape / contract reuse
// ---------------------------------------------------------------------------

void test("a usable result always passes the existing validateAppleBooksReaderPayload contract", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath } = await buildAppleBooksFixture(root, "joined", { partial: true });
    const result = await makeReader({ annotationDbPath: annotationPath }).readAnnotations();
    assert.ok(isUsableAppleBooksPayload(result));
    const payload = validateAppleBooksReaderPayload(result);
    assert.equal(payload.status, "partial");
  }));

// ---------------------------------------------------------------------------
// Payload equality against deterministic Python fixtures
// ---------------------------------------------------------------------------

interface PythonReaderCase {
  name: string;
  shape: "joined" | "asset-enriched" | "unsupported";
  options: { malformed?: boolean; partial?: boolean };
  result: {
    status: string;
    count: number;
    skipped_rows?: number;
    annotations: Array<Record<string, unknown>>;
  };
}

async function loadPythonFixtureCases(): Promise<PythonReaderCase[]> {
  const raw = await fs.readFile(path.resolve(__dirname, "../../tests/fixtures/apple-books/reader_payloads.json"), "utf8");
  return (JSON.parse(raw) as { cases: PythonReaderCase[] }).cases;
}

/**
 * `src/readingTypes.ts` explicitly documents `null` and an absent key as
 * equivalent for every optional `AppleBooksAnnotation` field ("the Apple
 * Books reader emits absent optional fields as JSON null (not by omitting
 * the key)"). The Python oracle emits explicit `null`s; this TypeScript
 * reader omits the key instead -- both are valid under that documented
 * equivalence, so payload-equality comparison drops `null`-valued keys from
 * the Python side rather than asserting byte-identical JSON shape.
 */
function dropNullValues(annotations: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return annotations.map((annotation) => Object.fromEntries(Object.entries(annotation).filter(([, value]) => value !== null)));
}

void test("TypeScript reader output matches the deterministic Python oracle fixture for every schema shape", async () => {
  const cases = await loadPythonFixtureCases();
  for (const pythonCase of cases) {
    await withFixtureRoot(async (root) => {
      const { annotationPath, libraryPath } = await buildAppleBooksFixture(root, pythonCase.shape, pythonCase.options);
      const result = await makeReader({
        annotationDbPath: annotationPath,
        libraryDbPath: pythonCase.shape === "asset-enriched" ? libraryPath : undefined,
      }).readAnnotations();
      assert.equal(result.status, pythonCase.result.status, pythonCase.name);
      assert.equal(result.count, pythonCase.result.count, pythonCase.name);
      if (pythonCase.result.skipped_rows !== undefined) {
        assert.equal(result.skipped_rows, pythonCase.result.skipped_rows, pythonCase.name);
      }
      assert.deepEqual(result.annotations, dropNullValues(pythonCase.result.annotations), pythonCase.name);
    });
  }
});

// ---------------------------------------------------------------------------
// snapshotRetries validation (constructor-time, before any fs/process call)
// ---------------------------------------------------------------------------

void test("constructor rejects a snapshotRetries below the minimum without touching fs or the process", () => {
  let touched = false;
  const fsAdapter = createNodeAppleBooksFsAdapter();
  const trackingFs: AppleBooksFsAdapter = { ...fsAdapter, probe: async (p) => { touched = true; return fsAdapter.probe(p); } };
  assert.throws(
    () =>
      new AppleBooksSqliteReader({
        sqliteProcess: createNodeSqliteProcess(),
        fs: trackingFs,
        config: {},
        homeDirectory: "/tmp",
        annotationDbPath: "/tmp/x.sqlite",
        snapshotRetries: MIN_SNAPSHOT_RETRIES - 1,
      }),
    AppleBooksConfigurationError,
  );
  assert.equal(touched, false);
});

void test("constructor rejects a snapshotRetries above the maximum", () => {
  assert.throws(
    () =>
      new AppleBooksSqliteReader({
        sqliteProcess: createNodeSqliteProcess(),
        fs: createNodeAppleBooksFsAdapter(),
        config: {},
        homeDirectory: "/tmp",
        annotationDbPath: "/tmp/x.sqlite",
        snapshotRetries: MAX_SNAPSHOT_RETRIES + 1,
      }),
    AppleBooksConfigurationError,
  );
});

void test("constructor rejects a fractional or non-integer snapshotRetries", () => {
  for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        new AppleBooksSqliteReader({
          sqliteProcess: createNodeSqliteProcess(),
          fs: createNodeAppleBooksFsAdapter(),
          config: {},
          homeDirectory: "/tmp",
          annotationDbPath: "/tmp/x.sqlite",
          snapshotRetries: bad,
        }),
      AppleBooksConfigurationError,
    );
  }
});

void test("constructor accepts snapshotRetries at both boundary values", () => {
  assert.doesNotThrow(() =>
    new AppleBooksSqliteReader({
      sqliteProcess: createNodeSqliteProcess(),
      fs: createNodeAppleBooksFsAdapter(),
      config: {},
      homeDirectory: "/tmp",
      annotationDbPath: "/tmp/x.sqlite",
      snapshotRetries: MIN_SNAPSHOT_RETRIES,
    }),
  );
  assert.doesNotThrow(() =>
    new AppleBooksSqliteReader({
      sqliteProcess: createNodeSqliteProcess(),
      fs: createNodeAppleBooksFsAdapter(),
      config: {},
      homeDirectory: "/tmp",
      annotationDbPath: "/tmp/x.sqlite",
      snapshotRetries: MAX_SNAPSHOT_RETRIES,
    }),
  );
});

// ---------------------------------------------------------------------------
// Permission denial (item 3) -- distinguished without parsing/leaking stderr
// ---------------------------------------------------------------------------

void test("readAnnotations returns permission_denied with Full Disk Access guidance when the annotation source is EACCES, without retry/backup", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath } = await buildAppleBooksFixture(root, "joined");
    const realFs = createNodeAppleBooksFsAdapter();
    let sqliteInvocations = 0;
    const countingProcess: SqliteProcess = {
      run: async (options) => {
        sqliteInvocations += 1;
        return createNodeSqliteProcess().run(options);
      },
    };
    const deniedFs: AppleBooksFsAdapter = {
      ...realFs,
      probe: async (p) => (p === annotationPath ? { kind: "permission-denied" } : realFs.probe(p)),
    };
    const reader = new AppleBooksSqliteReader({
      sqliteProcess: countingProcess,
      fs: deniedFs,
      config: {},
      homeDirectory: root,
      annotationDbPath: annotationPath,
      snapshotRetries: 3,
    });
    const result = await reader.readAnnotations();
    assert.equal(result.status, "permission_denied");
    assert.match(result.diagnostics[0]?.guidance ?? "", /Full Disk Access/);
    assert.equal(sqliteInvocations, 0, "permission-denied must short-circuit before any sqlite3 invocation, and never retry/backup");
  }));

void test("readAnnotations degrades gracefully (annotation-only success) when only the library source is permission-denied", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath, libraryPath } = await buildAppleBooksFixture(root, "asset-enriched");
    const realFs = createNodeAppleBooksFsAdapter();
    const deniedLibraryFs: AppleBooksFsAdapter = {
      ...realFs,
      probe: async (p) => (p === libraryPath ? { kind: "permission-denied" } : realFs.probe(p)),
    };
    const reader = new AppleBooksSqliteReader({
      sqliteProcess: createNodeSqliteProcess(),
      fs: deniedLibraryFs,
      config: {},
      homeDirectory: root,
      annotationDbPath: annotationPath,
      libraryDbPath: libraryPath,
    });
    const result = await reader.readAnnotations();
    assert.equal(result.status, "success");
    assert.equal(result.annotations[0]?.book_title, "", "library enrichment must be skipped, not fatal, when only the library is permission-denied");
  }));

void test("permission_denied never appears for a merely-missing annotation database (missing stays unavailable)", () =>
  withFixtureRoot(async (root) => {
    const reader = makeReader({ annotationDbPath: path.join(root, "does-not-exist.sqlite") });
    const result = await reader.readAnnotations();
    assert.equal(result.status, "unavailable");
  }));

// ---------------------------------------------------------------------------
// Cancellation (item 2) -- aborts the whole operation, cleans up owned temp dirs
// ---------------------------------------------------------------------------

void test("readAnnotations(signal) rejects immediately for an already-aborted signal without any sqlite3 invocation", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath } = await buildAppleBooksFixture(root, "joined");
    let sqliteInvocations = 0;
    const countingProcess: SqliteProcess = {
      run: async (options) => {
        sqliteInvocations += 1;
        return createNodeSqliteProcess().run(options);
      },
    };
    const reader = new AppleBooksSqliteReader({
      sqliteProcess: countingProcess,
      fs: createNodeAppleBooksFsAdapter(),
      config: {},
      homeDirectory: root,
      annotationDbPath: annotationPath,
    });
    const controller = new AbortController();
    controller.abort();
    const result = await reader.readAnnotations(controller.signal);
    assert.notEqual(result.status, "success");
    assert.equal(sqliteInvocations, 0);
  }));

void test("readAnnotations(signal) cancellation propagates through optional library enrichment rather than degrading silently", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath, libraryPath } = await buildAppleBooksFixture(root, "asset-enriched");
    const controller = new AbortController();
    const realProcess = createNodeSqliteProcess();
    // Abort as soon as the library database is queried, mid-read -- proves cancellation during
    // library enrichment aborts the whole result rather than silently falling back to
    // annotation-only success.
    const abortOnLibraryProcess: SqliteProcess = {
      run: async (options) => {
        if (options.dbPath === libraryPath) controller.abort();
        return realProcess.run(options);
      },
    };
    const reader = new AppleBooksSqliteReader({
      sqliteProcess: abortOnLibraryProcess,
      fs: createNodeAppleBooksFsAdapter(),
      config: {},
      homeDirectory: root,
      annotationDbPath: annotationPath,
      libraryDbPath: libraryPath,
    });
    const result = await reader.readAnnotations(controller.signal);
    assert.notEqual(result.status, "success", "cancellation during library enrichment must abort the whole read, not degrade to annotation-only success");
  }));

void test("readAnnotations(signal) cleans up its owned backup temp directory even when cancelled during backup-mode querying", () =>
  withFixtureRoot(async (root) => {
    const dbPath = path.join(root, "AEAnnotation.sqlite");
    await execFileP(SQLITE_BINARY_PATH, [
      dbPath,
      "PRAGMA journal_mode=WAL; CREATE TABLE ZAEANNOTATION (Z_PK INTEGER PRIMARY KEY, ZANNOTATIONUUID TEXT, ZANNOTATIONSELECTEDTEXT TEXT); INSERT INTO ZAEANNOTATION VALUES (1,'uuid-1','WAL passage.');",
    ]);
    const realFs = createNodeAppleBooksFsAdapter();
    const alwaysUnstableFs: AppleBooksFsAdapter = {
      ...realFs,
      probe: async (p) => (p.endsWith("-wal") ? { kind: "present", size: 0, mtimeMs: Date.now() + Math.random() } : realFs.probe(p)),
    };
    const controller = new AbortController();
    const realProcess = createNodeSqliteProcess();
    const abortAfterBackupProcess: SqliteProcess = {
      run: async (options) => {
        if (options.script.startsWith(".backup")) {
          const result = await realProcess.run(options);
          controller.abort();
          return result;
        }
        return realProcess.run(options);
      },
    };
    const before = await fs.readdir(os.tmpdir());
    const reader = new AppleBooksSqliteReader({
      sqliteProcess: abortAfterBackupProcess,
      fs: alwaysUnstableFs,
      config: {},
      homeDirectory: root,
      annotationDbPath: dbPath,
      snapshotRetries: 1,
    });
    const result = await reader.readAnnotations(controller.signal);
    assert.notEqual(result.status, "success");
    const after = await fs.readdir(os.tmpdir());
    const leaked = after.filter((entry) => entry.startsWith("mindmap-apple-books-") && !before.includes(entry));
    assert.deepEqual(leaked, [], "the owned backup temp dir must be cleaned up even when cancelled mid-query");
  }));

// ---------------------------------------------------------------------------
// Schema contains-fallback (item 5) -- two-stage discovery
// ---------------------------------------------------------------------------

void test("readAnnotations discovers a supported annotation table via the contains-fallback name, not just the fixed candidate list", () =>
  withFixtureRoot(async (root) => {
    const dbPath = path.join(root, "AEAnnotation.sqlite");
    // "ZCUSTOMANNOTATIONSTORE" is not ZAEANNOTATION/ZANNOTATION, but does contain "ANNOTATION" --
    // only reachable via findTable's contains-fallback, which requires querying PRAGMA table_info
    // against the table name actually selected, not a fixed candidate list.
    await execFileP(SQLITE_BINARY_PATH, [
      dbPath,
      "CREATE TABLE ZCUSTOMANNOTATIONSTORE (Z_PK INTEGER PRIMARY KEY, ZANNOTATIONUUID TEXT, ZANNOTATIONSELECTEDTEXT TEXT); INSERT INTO ZCUSTOMANNOTATIONSTORE VALUES (1,'uuid-1','Fallback-discovered passage.');",
    ]);
    const result = await makeReader({ annotationDbPath: dbPath }).readAnnotations();
    assert.equal(result.status, "success");
    assert.equal(result.count, 1);
    assert.equal(result.annotations[0]?.quote, "Fallback-discovered passage.");
  }));

// ---------------------------------------------------------------------------
// Deterministic row ordering (item 6)
// ---------------------------------------------------------------------------

void test("readAnnotations returns annotation rows in a deterministic rowid order across repeated reads", () =>
  withFixtureRoot(async (root) => {
    const dbPath = path.join(root, "AEAnnotation.sqlite");
    await execFileP(SQLITE_BINARY_PATH, [
      dbPath,
      `CREATE TABLE ZAEANNOTATION (Z_PK INTEGER PRIMARY KEY, ZANNOTATIONUUID TEXT, ZANNOTATIONSELECTEDTEXT TEXT);
       INSERT INTO ZAEANNOTATION VALUES (5,'uuid-e','Fifth.');
       INSERT INTO ZAEANNOTATION VALUES (1,'uuid-a','First.');
       INSERT INTO ZAEANNOTATION VALUES (3,'uuid-c','Third.');`,
    ]);
    const first = await makeReader({ annotationDbPath: dbPath }).readAnnotations();
    const second = await makeReader({ annotationDbPath: dbPath }).readAnnotations();
    const expectedOrder = ["aeannotation:uuid-a", "aeannotation:uuid-c", "aeannotation:uuid-e"];
    assert.deepEqual(first.annotations.map((a) => a.annotation_id), expectedOrder);
    assert.deepEqual(second.annotations.map((a) => a.annotation_id), expectedOrder);
  }));

// ---------------------------------------------------------------------------
// Library instability (item 6) -- a changing library triggers retry/fallback
// ---------------------------------------------------------------------------

void test("readAnnotations treats a changing library database as instability, retrying/falling back rather than returning a mixed enrichment snapshot", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath, libraryPath } = await buildAppleBooksFixture(root, "asset-enriched");
    const realFs = createNodeAppleBooksFsAdapter();
    let libraryProbeCalls = 0;
    const unstableLibraryFs: AppleBooksFsAdapter = {
      ...realFs,
      probe: async (p) => {
        const real = await realFs.probe(p);
        if (p === libraryPath && real.kind === "present") {
          libraryProbeCalls += 1;
          return { ...real, mtimeMs: real.mtimeMs + libraryProbeCalls };
        }
        return real;
      },
    };
    const reader = new AppleBooksSqliteReader({
      sqliteProcess: createNodeSqliteProcess(),
      fs: unstableLibraryFs,
      config: {},
      homeDirectory: root,
      annotationDbPath: annotationPath,
      libraryDbPath: libraryPath,
      snapshotRetries: 3,
    });
    const result = await reader.readAnnotations();
    assert.equal(result.status, "success");
    assert.equal(result.sources?.[0]?.snapshot, "sqlite-backup-file", "a perpetually-changing library must exhaust direct retries and fall back to backup mode, exactly like an unstable annotation database");
    assert.equal(result.annotations[0]?.book_title, "The Other Book", "the backup-mode read must still enrich correctly once both sources are stable copies");
  }));

// ---------------------------------------------------------------------------
// Failure classification (item 7) -- recoverable vs non-recoverable
// ---------------------------------------------------------------------------

void test("a binary-missing failure is never retried and never triggers backup fallback", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath } = await buildAppleBooksFixture(root, "joined");
    let invocations = 0;
    const alwaysMissingBinaryProcess: SqliteProcess = {
      run: async () => {
        invocations += 1;
        throw new SqliteProcessError("binary-missing", "The /usr/bin/sqlite3 executable was not found.");
      },
    };
    const reader = new AppleBooksSqliteReader({
      sqliteProcess: alwaysMissingBinaryProcess,
      fs: createNodeAppleBooksFsAdapter(),
      config: {},
      homeDirectory: root,
      annotationDbPath: annotationPath,
      snapshotRetries: 3,
    });
    const result = await reader.readAnnotations();
    assert.notEqual(result.status, "success");
    assert.equal(invocations, 1, "binary-missing must fail on the very first attempt -- no retry, no backup .backup invocation");
  }));

void test("an unsupported schema is never retried and never triggers backup fallback", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath } = await buildAppleBooksFixture(root, "unsupported");
    const scriptInvocations: string[] = [];
    const realProcess = createNodeSqliteProcess();
    const trackingProcess: SqliteProcess = {
      run: async (options) => {
        scriptInvocations.push(options.script);
        return realProcess.run(options);
      },
    };
    const reader = new AppleBooksSqliteReader({
      sqliteProcess: trackingProcess,
      fs: createNodeAppleBooksFsAdapter(),
      config: {},
      homeDirectory: root,
      annotationDbPath: annotationPath,
      snapshotRetries: 3,
    });
    const result = await reader.readAnnotations();
    assert.equal(result.status, "unsupported_schema");
    assert.equal(scriptInvocations.filter((s) => s.includes(".backup")).length, 0, "unsupported schema must never reach backup fallback");
  }));

void test("a transient exited-with-error failure IS eligible for retry and backup fallback", () =>
  withFixtureRoot(async (root) => {
    const { annotationPath } = await buildAppleBooksFixture(root, "joined");
    const realProcess = createNodeSqliteProcess();
    let directAttempts = 0;
    const flakyThenRecoveringProcess: SqliteProcess = {
      run: async (options) => {
        if (options.extraArgs.includes("-readonly") && !options.script.startsWith(".backup")) {
          directAttempts += 1;
          if (directAttempts <= 2) throw new Error("simulated transient failure");
        }
        return realProcess.run(options);
      },
    };
    const reader = new AppleBooksSqliteReader({
      sqliteProcess: flakyThenRecoveringProcess,
      fs: createNodeAppleBooksFsAdapter(),
      config: {},
      homeDirectory: root,
      annotationDbPath: annotationPath,
      snapshotRetries: 3,
    });
    const result = await reader.readAnnotations();
    assert.equal(result.status, "success", "a transient (non-classified-fatal) failure must be retried rather than immediately failing the whole read");
  }));

// ---------------------------------------------------------------------------
// Read-only integrity: db/-wal/-shm existence, size, mtime, and bytes
// unchanged across BOTH direct and forced-backup reads (item 3 closure)
// ---------------------------------------------------------------------------

interface SidecarSnapshot {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  bytes?: Buffer;
}

async function snapshotFile(filePath: string): Promise<SidecarSnapshot> {
  try {
    const [stat, bytes] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, bytes };
  } catch {
    return { exists: false };
  }
}

interface DatabaseSnapshot {
  db: SidecarSnapshot;
  wal: SidecarSnapshot;
  shm: SidecarSnapshot;
}

async function snapshotDatabase(dbPath: string): Promise<DatabaseSnapshot> {
  const [db, wal, shm] = await Promise.all([snapshotFile(dbPath), snapshotFile(`${dbPath}-wal`), snapshotFile(`${dbPath}-shm`)]);
  return { db, wal, shm };
}

void test("readAnnotations (direct mode, non-WAL fixture): db/-wal/-shm existence, size, mtime, and bytes are all byte-for-byte unchanged", () =>
  withFixtureRoot(async (root) => {
    // Deliberately NOT WAL mode: a rollback-journal-mode database has no -wal/-shm sidecars, and a
    // pure -readonly SELECT never creates them -- this is the case where "nothing touched at all"
    // (not just "content unchanged") is an achievable, meaningful guarantee for direct mode.
    const { annotationPath } = await buildAppleBooksFixture(root, "joined");
    const before = await snapshotDatabase(annotationPath);
    assert.equal(before.wal.exists, false, "the joined fixture must not be in WAL mode for this test to be meaningful");
    assert.equal(before.shm.exists, false);

    const result = await makeReader({ annotationDbPath: annotationPath }).readAnnotations();
    assert.equal(result.status, "success");
    assert.equal(result.sources?.[0]?.snapshot, "sqlite-direct", "this fixture must actually stay on the direct path for the test to prove what it claims");

    const after = await snapshotDatabase(annotationPath);
    for (const key of ["db", "wal", "shm"] as const) {
      assert.equal(after[key].exists, before[key].exists, `${key} existence changed`);
      if (before[key].exists) {
        assert.equal(after[key].size, before[key].size, `${key} size changed`);
        assert.equal(after[key].mtimeMs, before[key].mtimeMs, `${key} mtime changed`);
        assert.ok(after[key].bytes!.equals(before[key].bytes!), `${key} bytes changed`);
      }
    }
  }));

void test("readAnnotations (forced backup mode, WAL fixture): original db and -wal content are byte-for-byte unchanged; -shm keeps its size and is never removed (its content/mtime are inherent, harmless SQLite WAL bookkeeping, not a mutation)", () =>
  withFixtureRoot(async (root) => {
    // A WAL-mode database's -shm file is shared reader-lock/wal-index bookkeeping that SQLite
    // rewrites on every read CONNECTION -- direct AND via `.backup`, regardless of -readonly --
    // because each connection records its own read-mark slot there. Verified empirically against
    // the real /usr/bin/sqlite3 binary: even a single plain `-readonly` SELECT changes -shm's
    // mtime, and this reader's multi-query read (schema discovery + row fetch, each its own
    // connection) legitimately changes -shm's BYTES too, across attempts. None of that touches the
    // 32KB -shm region's meaning as anything but ephemeral, regenerable index bookkeeping -- it
    // carries zero annotation data and is not part of the database's recoverable content. This is
    // exactly why the reader's stability check treats any -shm change as "unstable" and
    // retries/falls back rather than trusting it -- the policy already accounts for this reality.
    // The meaningful, achievable integrity guarantee is on the DATA-BEARING files: the main .sqlite
    // file and the -wal log, both byte-for-byte unchanged, plus -shm never being deleted/resized/
    // corrupted (still exists, still exactly its original size).
    const dbPath = path.join(root, "AEAnnotation.sqlite");
    await execFileP(SQLITE_BINARY_PATH, [
      dbPath,
      "PRAGMA journal_mode=WAL; CREATE TABLE ZAEANNOTATION (Z_PK INTEGER PRIMARY KEY, ZANNOTATIONUUID TEXT, ZANNOTATIONSELECTEDTEXT TEXT); INSERT INTO ZAEANNOTATION VALUES (1,'uuid-1','Integrity passage.');",
    ]);
    const before = await snapshotDatabase(dbPath);
    assert.equal(before.wal.exists, true);
    assert.equal(before.shm.exists, true);

    // Force backup mode deterministically (same technique used elsewhere in this file) rather than
    // relying on WAL churn to happen to exhaust retries within the test's own timing.
    const realFs = createNodeAppleBooksFsAdapter();
    let mainDbStatCalls = 0;
    const flakyFs: AppleBooksFsAdapter = {
      ...realFs,
      async probe(filePath: string) {
        const real = await realFs.probe(filePath);
        if (real.kind === "present" && filePath === dbPath) {
          mainDbStatCalls += 1;
          return { ...real, mtimeMs: real.mtimeMs + mainDbStatCalls };
        }
        return real;
      },
    };
    const reader = new AppleBooksSqliteReader({
      sqliteProcess: createNodeSqliteProcess(),
      fs: flakyFs,
      config: {},
      homeDirectory: root,
      annotationDbPath: dbPath,
      snapshotRetries: 1,
    });
    const result = await reader.readAnnotations();
    assert.equal(result.status, "success");
    assert.equal(result.sources?.[0]?.snapshot, "sqlite-backup-file", "this test must actually exercise the backup path for the guarantee to mean anything");
    assert.equal(result.annotations[0]?.quote, "Integrity passage.");

    const after = await snapshotDatabase(dbPath);
    assert.equal(after.db.exists, true);
    assert.equal(after.wal.exists, true);
    assert.equal(after.shm.exists, true);
    assert.equal(after.db.size, before.db.size, "db size must be unchanged");
    assert.equal(after.db.mtimeMs, before.db.mtimeMs, "db mtime must be unchanged -- the main file itself is never touched by a read");
    assert.ok(after.db.bytes!.equals(before.db.bytes!), "db bytes must be byte-for-byte unchanged");
    assert.equal(after.wal.size, before.wal.size, "-wal size must be unchanged");
    assert.equal(after.wal.mtimeMs, before.wal.mtimeMs, "-wal mtime must be unchanged");
    assert.ok(after.wal.bytes!.equals(before.wal.bytes!), "-wal bytes must be byte-for-byte unchanged");
    assert.equal(after.shm.size, before.shm.size, "-shm must never be resized/truncated -- it may still be rewritten in place as inherent WAL-index bookkeeping, but never grows, shrinks, or disappears");
  }));
