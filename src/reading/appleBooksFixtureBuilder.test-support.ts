import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { SQLITE_BINARY_PATH } from "./sqliteProcess";

/**
 * Test-only deterministic SQLite fixture builder -- a TypeScript port of
 * tests/fixtures/apple_books_fixture.py's `build_fixture`, used only by
 * `*.test.ts` files in this directory (never imported by production code,
 * matching the Python fixture's own "development/test only" status).
 * Builds real on-disk SQLite databases via the same `/usr/bin/sqlite3`
 * binary the real adapter uses, so "Real /usr/bin/sqlite3 integration
 * tests may use only generated temp DBs" holds without any native driver.
 */

const execFileP = promisify(execFile);

export type FixtureShape = "joined" | "asset-enriched" | "unsupported";

export interface FixtureOptions {
  malformed?: boolean;
  partial?: boolean;
}

export interface FixturePaths {
  root: string;
  annotationPath: string;
  libraryPath: string;
}

async function runSql(dbPath: string, sql: string): Promise<void> {
  await execFileP(SQLITE_BINARY_PATH, [dbPath, sql]);
}

export async function makeFixtureRoot(prefix = "mindmap-apple-books-fixture-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function buildAppleBooksFixture(root: string, shape: FixtureShape, options: FixtureOptions = {}): Promise<FixturePaths> {
  const annotationPath = path.join(root, "AEAnnotation.sqlite");
  const libraryPath = path.join(root, "BKLibrary.sqlite");

  if (shape === "joined") {
    await runSql(
      annotationPath,
      `
      CREATE TABLE ZAEBOOK (Z_PK INTEGER PRIMARY KEY, ZTITLE TEXT, ZAUTHOR TEXT);
      CREATE TABLE ZAEANNOTATION (
        Z_PK INTEGER PRIMARY KEY,
        ZANNOTATIONUUID TEXT,
        ZANNOTATIONSELECTEDTEXT TEXT,
        ZANNOTATIONNOTE TEXT,
        ZANNOTATIONCHAPTER TEXT,
        ZANNOTATIONLOCATION TEXT,
        ZCREATIONDATE REAL,
        ZMODIFICATIONDATE REAL,
        ZANNOTATIONBOOK INTEGER
      );
      INSERT INTO ZAEBOOK VALUES (7, 'The Quiet Book', 'A. Reader');
      INSERT INTO ZAEANNOTATION VALUES (
        1, 'uuid-1', ${options.malformed ? "x'626164'" : "'A useful highlighted passage.'"},
        'A personal note.', 'Chapter One', '42', 100000000.0, 100000100.0, 7
      );
      INSERT INTO ZAEANNOTATION VALUES (2, 'uuid-tombstone', '', NULL, NULL, NULL, NULL, NULL, 7);
      ${options.partial ? "INSERT INTO ZAEANNOTATION VALUES (3, 'uuid-malformed', x'626164726f77', NULL, NULL, NULL, NULL, NULL, 7);" : ""}
      `,
    );
  } else if (shape === "asset-enriched") {
    await runSql(
      annotationPath,
      `
      CREATE TABLE ZANNOTATION (
        Z_PK INTEGER PRIMARY KEY,
        ZANNOTATIONSELECTEDTEXT TEXT,
        ZANNOTATIONNOTE TEXT,
        ZFUTUREPROOFING5 TEXT,
        ZPLLOCATIONRANGESTART INTEGER,
        ZANNOTATIONCREATIONDATE REAL,
        ZANNOTATIONMODIFICATIONDATE REAL,
        ZANNOTATIONASSETID TEXT
      );
      INSERT INTO ZANNOTATION VALUES (10, 'A second schema passage.', NULL, 'Part II', 88, 200000000.0, 200000010.0, 'asset-10');
      `,
    );
    await runSql(
      libraryPath,
      `
      CREATE TABLE ZBKLIBRARYASSET (
        Z_PK INTEGER PRIMARY KEY,
        ZASSETID TEXT,
        ZTITLE TEXT,
        ZAUTHORFAMILYNAME TEXT,
        ZAUTHORGIVENNAME TEXT
      );
      INSERT INTO ZBKLIBRARYASSET VALUES (1, 'asset-10', 'The Other Book', 'Writer', 'B.');
      `,
    );
  } else if (shape === "unsupported") {
    await runSql(annotationPath, "CREATE TABLE ZNOT_APPLE (id INTEGER PRIMARY KEY);");
  }

  return { root, annotationPath, libraryPath };
}

export async function cleanupFixtureRoot(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}
