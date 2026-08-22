import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { selectAppleBooksDatabaseRoles, type AppleBooksDiscoveryFileSystem } from "../appleBooksDiscovery";
import type { AppleBooksAnnotation, AppleBooksSourceMetadata, ReaderPayloadStatus } from "../readingTypes";
import {
  ANNOTATION_ASSET_COLUMNS,
  ANNOTATION_BOOK_FK_COLUMNS,
  ANNOTATION_CHAPTER_COLUMNS,
  ANNOTATION_CREATED_COLUMNS,
  ANNOTATION_IDENTITY_COLUMNS,
  ANNOTATION_LOCATION_COLUMNS,
  ANNOTATION_MODIFIED_COLUMNS,
  ANNOTATION_NOTE_COLUMNS,
  ANNOTATION_QUOTE_COLUMNS,
  ANNOTATION_TABLE_CANDIDATES,
  ANNOTATION_TABLE_CONTAINS,
  AUTHOR_COLUMNS,
  AUTHOR_FAMILY_COLUMNS,
  AUTHOR_GIVEN_COLUMNS,
  authorFromRow,
  BOOK_TABLE_CANDIDATES,
  BOOK_TABLE_CONTAINS,
  BOOK_TITLE_COLUMNS,
  columnSetFromPragma,
  findTable,
  LIBRARY_ASSET_ID_COLUMNS,
  LIBRARY_TABLE_CANDIDATES,
  LIBRARY_TABLE_CONTAINS,
  parseText,
  parseTimestamp,
  pickColumn,
  quoteSqlIdentifier,
  SchemaValueError,
  typedValueJsonFragment,
  type TypedValue,
} from "./appleBooksSchema";
import { SqliteProcessError, type SqliteProcess } from "./sqliteProcess";

/**
 * Ports python/apple_books_reader.py's orchestration (`discover_*_database`,
 * `_snapshot`, `read_annotations`) as a behavioral port over the
 * `/usr/bin/sqlite3` subprocess seam, producing the exact same
 * `AppleBooksReaderPayload` shape `src/readingTypes.ts` already defines and
 * validates -- this module never introduces a new payload contract.
 */

export type AppleBooksProbeResult =
  | { kind: "present"; size: number; mtimeMs: number }
  | { kind: "missing" }
  | { kind: "permission-denied" }
  | { kind: "unavailable" };

export interface AppleBooksFsAdapter extends AppleBooksDiscoveryFileSystem {
  /**
   * Typed access probe -- distinguishes "does not exist" from "exists but
   * access was denied" from any other stat failure, using the underlying
   * `fs.stat` error code (`ENOENT` / `EACCES`+`EPERM` / anything else)
   * rather than parsing any error text. This is what lets the reader
   * return a distinct `permission_denied` status (with Full Disk Access
   * guidance) instead of folding every access problem into a generic
   * "unavailable".
   */
  probe(filePath: string): Promise<AppleBooksProbeResult>;
  /** Creates a fresh, uniquely-named directory under `prefix` (e.g. via `fs.mkdtemp`) and returns its path. */
  mkdtemp(prefix: string): Promise<string>;
  /** Recursively removes a directory this module itself created via `mkdtemp` -- never called with any other path. */
  rmDirRecursive(dirPath: string): Promise<void>;
}

/** Real `AppleBooksFsAdapter` over `node:fs/promises` -- never wired to main.ts/production commands by this checkpoint. `mkdtemp`'s `prefix` is joined under `os.tmpdir()`, matching Python's `tempfile.TemporaryDirectory(prefix=...)`. */
export function createNodeAppleBooksFsAdapter(): AppleBooksFsAdapter {
  return {
    async readdir(directory: string): Promise<string[]> {
      return fs.readdir(directory);
    },
    async probe(filePath: string): Promise<AppleBooksProbeResult> {
      try {
        const stat = await fs.stat(filePath);
        return { kind: "present", size: stat.size, mtimeMs: stat.mtimeMs };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT") return { kind: "missing" };
        if (code === "EACCES" || code === "EPERM") return { kind: "permission-denied" };
        return { kind: "unavailable" };
      }
    },
    async mkdtemp(prefix: string): Promise<string> {
      return fs.mkdtemp(path.join(os.tmpdir(), prefix));
    },
    async rmDirRecursive(dirPath: string): Promise<void> {
      await fs.rm(dirPath, { recursive: true, force: true });
    },
  };
}

export type AppleBooksReadStatus = ReaderPayloadStatus | "unavailable" | "permission_denied" | "unsupported_schema" | "malformed_rows" | "source_changing";

export interface AppleBooksReadResult {
  version: 1;
  status: AppleBooksReadStatus;
  annotations: AppleBooksAnnotation[];
  diagnostics: Array<{ severity: "error" | "warning"; code: string; message: string; guidance: string }>;
  count: number;
  skipped_rows?: number;
  sources?: AppleBooksSourceMetadata[];
}

/** True exactly when `result` is shaped like a usable `AppleBooksReaderPayload` (the caller may pass it straight to `validateAppleBooksReaderPayload`). */
export function isUsableAppleBooksPayload(result: AppleBooksReadResult): result is AppleBooksReadResult & { status: ReaderPayloadStatus } {
  return result.status === "success" || result.status === "partial" || result.status === "empty";
}

class ReaderFailure extends Error {
  constructor(
    readonly status: Exclude<AppleBooksReadStatus, ReaderPayloadStatus>,
    readonly code: string,
    message: string,
    readonly guidance: string,
  ) {
    super(message);
    this.name = "ReaderFailure";
  }
}

/**
 * Closed set of failure classes that must never be retried or sent through
 * backup fallback: the source genuinely lacks access/support, the caller
 * cancelled, or the output was rejected as unsafe/unparseable -- retrying
 * or copying-then-retrying any of these can only waste time or (for
 * permission/cancellation) do something the caller didn't ask for.
 * Everything else (a transient open/read failure, an unstable
 * before/after snapshot, a timeout) is presumed possibly-transient and is
 * eligible for the bounded retry-then-backup path.
 */
const NON_RECOVERABLE_STATUSES: ReadonlySet<AppleBooksReadStatus> = new Set(["permission_denied", "unsupported_schema"]);
const NON_RECOVERABLE_CODES: ReadonlySet<string> = new Set([
  "APPLE_BOOKS_SQLITE_BINARY_MISSING",
  "APPLE_BOOKS_SQLITE_CANCELLED",
  "APPLE_BOOKS_SQLITE_OUTPUT_TOO_LARGE",
  "APPLE_BOOKS_MALFORMED_OUTPUT",
]);

function isRecoverableFailure(failure: ReaderFailure): boolean {
  return !NON_RECOVERABLE_STATUSES.has(failure.status) && !NON_RECOVERABLE_CODES.has(failure.code);
}

function isCancellationFailure(failure: ReaderFailure): boolean {
  return failure.code === "APPLE_BOOKS_SQLITE_CANCELLED";
}

function diagnostic(code: string, message: string, guidance: string, severity: "error" | "warning" = "error") {
  return { severity, code, message, guidance };
}

const GUIDANCE_OPEN_OR_CONFIGURE = "Open Apple Books or configure a readable database path, then retry.";
const GUIDANCE_FULL_DISK_ACCESS = "Grant Mindmap Full Disk Access in System Settings > Privacy & Security, then retry.";

export interface AppleBooksSqliteReaderOptions {
  sqliteProcess: SqliteProcess;
  fs: AppleBooksFsAdapter;
  config: Record<string, unknown>;
  homeDirectory: string;
  /** Absolute override for the annotation database path (skips discovery). */
  annotationDbPath?: string;
  /** Absolute override for the library database path (skips discovery). */
  libraryDbPath?: string;
  /** Bounded retries of the whole direct-read sequence when the source changes mid-read. Must be an integer in `[MIN_SNAPSHOT_RETRIES, MAX_SNAPSHOT_RETRIES]`; validated in the constructor, before any fs/process call. Matches Python's `snapshot_retries` default of 3. */
  snapshotRetries?: number;
  /** Per-`sqlite3` invocation timeout; must be <= 60000ms (enforced by `SqliteProcess`). */
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const DEFAULT_SNAPSHOT_RETRIES = 3;
export const MIN_SNAPSHOT_RETRIES = 1;
export const MAX_SNAPSHOT_RETRIES = 5;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const BACKUP_TEMP_PREFIX = "mindmap-apple-books-";
const BACKUP_FILE_NAME = "backup.sqlite";
/** Every path this module ever passes inside a sqlite3 dot-command string (`.backup <dest>`) is validated against this charset first -- the CLI's own dot-command line splits on whitespace, so a path containing a space/quote could otherwise be misparsed. */
const SAFE_BACKUP_PATH_PATTERN = /^[A-Za-z0-9_\-./]+$/;

export class AppleBooksConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleBooksConfigurationError";
  }
}

interface FileState {
  name: string;
  size: number;
  mtimeMs: number;
}

async function fileState(fs: AppleBooksFsAdapter, dbPath: string): Promise<FileState[]> {
  const candidates = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const states: FileState[] = [];
  for (const candidate of candidates) {
    const probe = await fs.probe(candidate);
    states.push({ name: path.basename(candidate), size: probe.kind === "present" ? probe.size : 0, mtimeMs: probe.kind === "present" ? probe.mtimeMs : 0 });
  }
  return states;
}

/** Combines annotation-DB and (when present) library-DB file states into one comparable snapshot, so a library that changes mid-read is detected as instability exactly like the annotation database changing -- never silently left as a stale/mixed enrichment source. */
async function combinedFileState(fs: AppleBooksFsAdapter, annotationDbPath: string, libraryDbPath: string | null): Promise<FileState[]> {
  const annotationStates = await fileState(fs, annotationDbPath);
  if (!libraryDbPath) return annotationStates;
  const libraryStates = await fileState(fs, libraryDbPath);
  return [...annotationStates, ...libraryStates.map((entry) => ({ ...entry, name: `library:${entry.name}` }))];
}

function statesEqual(a: FileState[], b: FileState[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => entry.name === b[index].name && entry.size === b[index].size && entry.mtimeMs === b[index].mtimeMs);
}

function walPresent(states: FileState[]): boolean {
  return states.some((entry) => entry.name.endsWith("-wal") && entry.size > 0);
}

/** Splits sqlite3's stdout into one parsed JSON value per non-empty line, in order -- the shape every query in this module's scripts is built to produce via `json_group_array(...)`. Throws a `ReaderFailure` if the count doesn't match `expectedCount` or any line fails to parse. */
function parseJsonLines(stdout: string, expectedCount: number): unknown[] {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  if (lines.length !== expectedCount) {
    throw new ReaderFailure(
      "unavailable",
      "APPLE_BOOKS_MALFORMED_OUTPUT",
      "Apple Books database query produced unexpected output.",
      GUIDANCE_OPEN_OR_CONFIGURE,
    );
  }
  return lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new ReaderFailure(
        "unavailable",
        "APPLE_BOOKS_MALFORMED_OUTPUT",
        "Apple Books database query produced output that was not valid JSON.",
        GUIDANCE_OPEN_OR_CONFIGURE,
      );
    }
  });
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

interface PragmaRow {
  name?: unknown;
}

function asPragmaRows(value: unknown): PragmaRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PragmaRow => typeof entry === "object" && entry !== null);
}

function typedField(row: Record<string, unknown> | undefined, alias: string): TypedValue | undefined {
  const raw = row?.[alias];
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.type !== "string") return undefined;
  return { value: record.value, type: record.type as TypedValue["type"] };
}

/** Wraps a script's queries with an explicit read transaction, so every query in one invocation observes one consistent snapshot of the (possibly WAL-mode) source. */
function transactionScript(queries: readonly string[]): string {
  return `BEGIN;\n${queries.join("\n")}\nCOMMIT;\n`;
}

/**
 * `"direct"` queries the Apple-owned source with `-readonly` -- the
 * required safety mode for a file this module never wrote and must never
 * modify. `"backup"` queries this module's own private `.backup` copy
 * (already fully isolated from the Apple-owned source) without
 * `-readonly`: a WAL-mode database cannot always be opened read-only when
 * its `-shm` companion doesn't exist yet (SQLite needs to create it for
 * the wal-index), which `.backup` output frequently is since it inherits
 * the source's journal mode. Opening the backup copy read-write is safe
 * specifically because it is a copy this module owns and never writes to
 * -- the same safety guarantee `-readonly` exists for is preserved by
 * construction, not by the flag.
 */
type QueryMode = "direct" | "backup";

function queryExtraArgs(mode: QueryMode): string[] {
  return mode === "direct" ? ["-readonly", "-batch", "-list"] : ["-batch", "-list"];
}

async function runQueries(
  sqliteProcess: SqliteProcess,
  dbPath: string,
  mode: QueryMode,
  queries: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
): Promise<unknown[]> {
  let stdout: string;
  try {
    const result = await sqliteProcess.run({
      script: transactionScript(queries),
      extraArgs: queryExtraArgs(mode),
      dbPath,
      timeoutMs,
      maxOutputBytes,
      signal,
    });
    stdout = result.stdout;
  } catch (error) {
    throw toReaderFailure(error);
  }
  return parseJsonLines(stdout, queries.length);
}

function toReaderFailure(error: unknown): ReaderFailure {
  if (error instanceof ReaderFailure) return error;
  if (error instanceof SqliteProcessError) {
    switch (error.kind) {
      case "binary-missing":
        return new ReaderFailure("unavailable", "APPLE_BOOKS_SQLITE_BINARY_MISSING", "The sqlite3 command-line tool is not available.", GUIDANCE_OPEN_OR_CONFIGURE);
      case "timeout":
        return new ReaderFailure("unavailable", "APPLE_BOOKS_SQLITE_TIMEOUT", "Apple Books database query did not complete in time.", GUIDANCE_OPEN_OR_CONFIGURE);
      case "cancelled":
        return new ReaderFailure("unavailable", "APPLE_BOOKS_SQLITE_CANCELLED", "Apple Books database query was cancelled.", GUIDANCE_OPEN_OR_CONFIGURE);
      case "output-too-large":
        return new ReaderFailure("unavailable", "APPLE_BOOKS_SQLITE_OUTPUT_TOO_LARGE", "Apple Books database query produced too much output.", GUIDANCE_OPEN_OR_CONFIGURE);
      default:
        return new ReaderFailure("unavailable", "APPLE_BOOKS_DATABASE_UNAVAILABLE", "Apple Books database could not be read.", GUIDANCE_OPEN_OR_CONFIGURE);
    }
  }
  return new ReaderFailure("unavailable", "APPLE_BOOKS_DATABASE_UNAVAILABLE", "Apple Books database could not be read.", GUIDANCE_OPEN_OR_CONFIGURE);
}

interface AnnotationSchema {
  annotationTable: string;
  identityColumns: string[];
  quoteColumn: string;
  noteColumn: string | null;
  chapterColumn: string | null;
  locationColumn: string | null;
  createdColumn: string | null;
  modifiedColumn: string | null;
  bookFkColumn: string | null;
  assetColumn: string | null;
  bookTable: string | null;
  bookTitleColumn: string | null;
  bookAuthorColumn: string | null;
  bookFamilyColumn: string | null;
  bookGivenColumn: string | null;
}

const LIST_TABLES_QUERY = "SELECT json_group_array(json_object('name', name)) FROM sqlite_master WHERE type = 'table';";

function pragmaTableInfoQuery(table: string): string {
  return `SELECT json_group_array(json_object('name', name)) FROM pragma_table_info('${table.replace(/'/g, "''")}');`;
}

async function listTables(
  sqliteProcess: SqliteProcess,
  dbPath: string,
  mode: QueryMode,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const [result] = await runQueries(sqliteProcess, dbPath, mode, [LIST_TABLES_QUERY], timeoutMs, maxOutputBytes, signal);
  return asStringArray(asPragmaRows(result).map((row) => row.name));
}

/**
 * Two-stage discovery, matching the two-stage nature of "which table" vs
 * "what columns does it have": stage 1 lists every table so `findTable`'s
 * exact-candidate AND contains-fallback selection can consider the real
 * table set; stage 2 runs `PRAGMA table_info` against exactly the table
 * NAME that was actually selected. A single-stage design that only ever
 * queries `PRAGMA table_info` for the fixed candidate name list would
 * silently return zero columns (and therefore "unsupported schema") for a
 * table `findTable` legitimately selected via its contains-fallback but
 * that isn't one of the fixed candidates.
 */
async function discoverAnnotationSchema(
  sqliteProcess: SqliteProcess,
  dbPath: string,
  mode: QueryMode,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
): Promise<AnnotationSchema> {
  const tableNames = await listTables(sqliteProcess, dbPath, mode, timeoutMs, maxOutputBytes, signal);
  const annotationTable = findTable(tableNames, ANNOTATION_TABLE_CANDIDATES, ANNOTATION_TABLE_CONTAINS);
  if (!annotationTable) {
    throw new ReaderFailure(
      "unsupported_schema",
      "APPLE_BOOKS_SCHEMA_UNSUPPORTED",
      "Apple Books annotation schema is not recognized.",
      "Configure a supported AEAnnotation database and retry.",
    );
  }
  const bookTableGuess = findTable(tableNames, BOOK_TABLE_CANDIDATES, BOOK_TABLE_CONTAINS);

  const pragmaQueries = [pragmaTableInfoQuery(annotationTable)];
  if (bookTableGuess) pragmaQueries.push(pragmaTableInfoQuery(bookTableGuess));
  const pragmaResults = await runQueries(sqliteProcess, dbPath, mode, pragmaQueries, timeoutMs, maxOutputBytes, signal);

  const annotationColumns = columnSetFromPragma(asPragmaRows(pragmaResults[0]));
  const identityColumns = ANNOTATION_IDENTITY_COLUMNS.filter((name) => annotationColumns.has(name));
  const quoteColumn = pickColumn(annotationColumns, ...ANNOTATION_QUOTE_COLUMNS);
  if (identityColumns.length === 0 || !quoteColumn) {
    throw new ReaderFailure(
      "unsupported_schema",
      "APPLE_BOOKS_SCHEMA_UNSUPPORTED",
      "Apple Books annotation table lacks the supported ID or quote columns.",
      "Use an Apple Books AEAnnotation database with annotation text and identity columns.",
    );
  }
  const bookFkColumn = pickColumn(annotationColumns, ...ANNOTATION_BOOK_FK_COLUMNS);
  const bookTable = bookFkColumn ? bookTableGuess : null;
  const bookColumns = bookTable && pragmaResults[1] ? columnSetFromPragma(asPragmaRows(pragmaResults[1])) : new Set<string>();

  return {
    annotationTable,
    identityColumns,
    quoteColumn,
    noteColumn: pickColumn(annotationColumns, ...ANNOTATION_NOTE_COLUMNS),
    chapterColumn: pickColumn(annotationColumns, ...ANNOTATION_CHAPTER_COLUMNS),
    locationColumn: pickColumn(annotationColumns, ...ANNOTATION_LOCATION_COLUMNS),
    createdColumn: pickColumn(annotationColumns, ...ANNOTATION_CREATED_COLUMNS),
    modifiedColumn: pickColumn(annotationColumns, ...ANNOTATION_MODIFIED_COLUMNS),
    bookFkColumn,
    assetColumn: pickColumn(annotationColumns, ...ANNOTATION_ASSET_COLUMNS),
    bookTable,
    bookTitleColumn: bookTable ? pickColumn(bookColumns, ...BOOK_TITLE_COLUMNS) : null,
    bookAuthorColumn: bookTable ? pickColumn(bookColumns, ...AUTHOR_COLUMNS) : null,
    bookFamilyColumn: bookTable ? pickColumn(bookColumns, ...AUTHOR_FAMILY_COLUMNS) : null,
    bookGivenColumn: bookTable ? pickColumn(bookColumns, ...AUTHOR_GIVEN_COLUMNS) : null,
  };
}

interface RawAnnotationRow {
  [key: string]: unknown;
}

function buildAnnotationRowFragments(schema: AnnotationSchema): { alias: string; expr: string }[] {
  const fragments: { alias: string; expr: string }[] = [];
  schema.identityColumns.forEach((column, index) => {
    fragments.push({ alias: `id${index}`, expr: quoteSqlIdentifier(column) });
  });
  fragments.push({ alias: "quote", expr: quoteSqlIdentifier(schema.quoteColumn) });
  if (schema.noteColumn) fragments.push({ alias: "note", expr: quoteSqlIdentifier(schema.noteColumn) });
  if (schema.chapterColumn) fragments.push({ alias: "chapter", expr: quoteSqlIdentifier(schema.chapterColumn) });
  if (schema.locationColumn) fragments.push({ alias: "location", expr: quoteSqlIdentifier(schema.locationColumn) });
  if (schema.createdColumn) fragments.push({ alias: "created", expr: quoteSqlIdentifier(schema.createdColumn) });
  if (schema.modifiedColumn) fragments.push({ alias: "modified", expr: quoteSqlIdentifier(schema.modifiedColumn) });
  if (schema.bookFkColumn) fragments.push({ alias: "bookFk", expr: quoteSqlIdentifier(schema.bookFkColumn) });
  if (schema.assetColumn) fragments.push({ alias: "asset", expr: quoteSqlIdentifier(schema.assetColumn) });
  return fragments;
}

async function fetchAnnotationRows(
  sqliteProcess: SqliteProcess,
  dbPath: string,
  mode: QueryMode,
  schema: AnnotationSchema,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
): Promise<{ rows: RawAnnotationRow[]; bookRows: RawAnnotationRow[] }> {
  const rowFragments = buildAnnotationRowFragments(schema);
  const rowObject = rowFragments.map(({ alias, expr }) => typedValueJsonFragment(alias, expr)).join(", ");
  // Row order must be deterministic. An `ORDER BY` on the OUTER query is ineffective here: the
  // outer query collapses to a single output row (the json_group_array aggregate), so there is
  // nothing left for that ORDER BY to reorder. The rows must be ordered in a real subquery BEFORE
  // they are fed into the aggregate.
  const orderedAnnotationTable = `(SELECT * FROM ${quoteSqlIdentifier(schema.annotationTable)} ORDER BY rowid)`;
  const queries = [`SELECT json_group_array(json_object(${rowObject})) FROM ${orderedAnnotationTable};`];

  const bookFragments: { alias: string; expr: string }[] = [];
  if (schema.bookTable) {
    bookFragments.push({ alias: "pk", expr: quoteSqlIdentifier("Z_PK") });
    if (schema.bookTitleColumn) bookFragments.push({ alias: "title", expr: quoteSqlIdentifier(schema.bookTitleColumn) });
    if (schema.bookAuthorColumn) bookFragments.push({ alias: "author", expr: quoteSqlIdentifier(schema.bookAuthorColumn) });
    if (schema.bookFamilyColumn) bookFragments.push({ alias: "family", expr: quoteSqlIdentifier(schema.bookFamilyColumn) });
    if (schema.bookGivenColumn) bookFragments.push({ alias: "given", expr: quoteSqlIdentifier(schema.bookGivenColumn) });
    const bookRowObject = bookFragments.map(({ alias, expr }) => typedValueJsonFragment(alias, expr)).join(", ");
    queries.push(`SELECT json_group_array(json_object(${bookRowObject})) FROM ${quoteSqlIdentifier(schema.bookTable)};`);
  }

  const results = await runQueries(sqliteProcess, dbPath, mode, queries, timeoutMs, maxOutputBytes, signal);
  const rows = Array.isArray(results[0]) ? (results[0] as RawAnnotationRow[]) : [];
  const bookRows = schema.bookTable && Array.isArray(results[1]) ? (results[1] as RawAnnotationRow[]) : [];
  return { rows, bookRows };
}

interface LibrarySchema {
  libraryTable: string;
  assetIdColumn: string;
  titleColumn: string;
  authorColumn: string | null;
  familyColumn: string | null;
  givenColumn: string | null;
}

async function discoverLibrarySchema(
  sqliteProcess: SqliteProcess,
  dbPath: string,
  mode: QueryMode,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
): Promise<LibrarySchema | null> {
  const tableNames = await listTables(sqliteProcess, dbPath, mode, timeoutMs, maxOutputBytes, signal);
  const libraryTable = findTable(tableNames, LIBRARY_TABLE_CANDIDATES, LIBRARY_TABLE_CONTAINS);
  if (!libraryTable) return null;
  const [pragmaResult] = await runQueries(sqliteProcess, dbPath, mode, [pragmaTableInfoQuery(libraryTable)], timeoutMs, maxOutputBytes, signal);
  const columns = columnSetFromPragma(asPragmaRows(pragmaResult));
  const assetIdColumn = pickColumn(columns, ...LIBRARY_ASSET_ID_COLUMNS);
  const titleColumn = pickColumn(columns, ...BOOK_TITLE_COLUMNS);
  if (!assetIdColumn || !titleColumn) return null;
  return {
    libraryTable,
    assetIdColumn,
    titleColumn,
    authorColumn: pickColumn(columns, ...AUTHOR_COLUMNS),
    familyColumn: pickColumn(columns, ...AUTHOR_FAMILY_COLUMNS),
    givenColumn: pickColumn(columns, ...AUTHOR_GIVEN_COLUMNS),
  };
}

async function fetchLibraryMap(
  sqliteProcess: SqliteProcess,
  dbPath: string,
  mode: QueryMode,
  schema: LibrarySchema,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
): Promise<Map<string, { title: string; author: string | null }>> {
  const fragments: { alias: string; expr: string }[] = [
    { alias: "assetId", expr: quoteSqlIdentifier(schema.assetIdColumn) },
    { alias: "title", expr: quoteSqlIdentifier(schema.titleColumn) },
  ];
  if (schema.authorColumn) fragments.push({ alias: "author", expr: quoteSqlIdentifier(schema.authorColumn) });
  if (schema.familyColumn) fragments.push({ alias: "family", expr: quoteSqlIdentifier(schema.familyColumn) });
  if (schema.givenColumn) fragments.push({ alias: "given", expr: quoteSqlIdentifier(schema.givenColumn) });
  const rowObject = fragments.map(({ alias, expr }) => typedValueJsonFragment(alias, expr)).join(", ");
  const [rows] = await runQueries(
    sqliteProcess,
    dbPath,
    mode,
    [`SELECT json_group_array(json_object(${rowObject})) FROM ${quoteSqlIdentifier(schema.libraryTable)};`],
    timeoutMs,
    maxOutputBytes,
    signal,
  );
  const map = new Map<string, { title: string; author: string | null }>();
  if (!Array.isArray(rows)) return map;
  for (const raw of rows as RawAnnotationRow[]) {
    try {
      const assetId = parseText(typedField(raw, "assetId"), "asset ID", true);
      const title = parseText(typedField(raw, "title"), "book title", true);
      if (!assetId || !title) continue;
      const author = authorFromRow({ author: typedField(raw, "author"), familyName: typedField(raw, "family"), givenName: typedField(raw, "given") });
      map.set(assetId, { title, author });
    } catch {
      // Mirrors _library_map: a malformed library row is skipped, never fatal to the whole read.
    }
  }
  return map;
}

function bookMapFromRows(rows: RawAnnotationRow[]): Map<number | string, { title: string | null; author: string | null }> {
  const map = new Map<number | string, { title: string | null; author: string | null }>();
  for (const raw of rows) {
    const pkTyped = typedField(raw, "pk");
    if (!pkTyped || pkTyped.type !== "integer") continue;
    const pk = pkTyped.value as number;
    let title: string | null;
    let author: string | null;
    try {
      title = parseText(typedField(raw, "title"), "book title");
      author = authorFromRow({ author: typedField(raw, "author"), familyName: typedField(raw, "family"), givenName: typedField(raw, "given") });
    } catch {
      continue;
    }
    map.set(pk, { title, author });
  }
  return map;
}

function normalizeAnnotationRows(
  rows: RawAnnotationRow[],
  schema: AnnotationSchema,
  bookMap: Map<number | string, { title: string | null; author: string | null }>,
  libraryMap: Map<string, { title: string; author: string | null }>,
): { annotations: AppleBooksAnnotation[]; malformed: number } {
  const annotations: AppleBooksAnnotation[] = [];
  let malformed = 0;
  for (const raw of rows) {
    try {
      const quoteTyped = typedField(raw, "quote");
      const rawQuoteValue = quoteTyped?.value;
      if (rawQuoteValue === null || rawQuoteValue === undefined || (typeof rawQuoteValue === "string" && rawQuoteValue.trim() === "")) {
        // Apple keeps inactive/tombstone rows in this table -- silently skipped, not malformed.
        continue;
      }
      let rawId: string | null = null;
      for (let index = 0; index < schema.identityColumns.length; index += 1) {
        try {
          const candidate = parseText(typedField(raw, `id${index}`), "annotation ID");
          if (candidate) {
            rawId = candidate;
            break;
          }
        } catch {
          continue;
        }
      }
      if (!rawId) throw new SchemaValueError("missing annotation ID");
      const quote = parseText(quoteTyped, "quote", true);
      if (!quote) throw new SchemaValueError("empty quote");

      let bookTitle: string | null = null;
      let author: string | null = null;
      if (schema.bookFkColumn) {
        const fkTyped = typedField(raw, "bookFk");
        if (fkTyped && fkTyped.type === "integer") {
          const entry = bookMap.get(fkTyped.value as number);
          if (entry) {
            bookTitle = entry.title;
            author = entry.author;
          }
        }
      }
      const assetId = parseText(typedField(raw, "asset"), "asset ID");
      if (assetId && libraryMap.has(assetId)) {
        const entry = libraryMap.get(assetId)!;
        bookTitle = entry.title;
        author = entry.author;
      }

      const annotation: AppleBooksAnnotation = {
        annotation_id: `aeannotation:${rawId}`,
        quote,
        book_title: bookTitle ?? "",
      };
      const userNote = parseText(typedField(raw, "note"), "user note");
      if (userNote !== null) annotation.user_note = userNote;
      if (author !== null) annotation.author = author;
      const chapter = parseText(typedField(raw, "chapter"), "chapter");
      if (chapter !== null) annotation.chapter = chapter;
      const location = parseText(typedField(raw, "location"), "location");
      if (location !== null) annotation.location = location;
      const createdAt = parseTimestamp(typedField(raw, "created"), "creation timestamp");
      if (createdAt !== null) annotation.created_at = createdAt;
      const modifiedAt = parseTimestamp(typedField(raw, "modified"), "modification timestamp");
      if (modifiedAt !== null) annotation.modified_at = modifiedAt;
      annotations.push(annotation);
    } catch {
      malformed += 1;
    }
  }
  return { annotations, malformed };
}

const SAFE_FILENAME_PATTERN = /^[^/\\]+$/;

function safeBasename(dbPath: string): string {
  const filename = path.basename(dbPath);
  return SAFE_FILENAME_PATTERN.test(filename) ? filename : "apple-books.sqlite";
}

function sourceMetadata(dbPath: string, role: string, schema: string, states: FileState[]): AppleBooksSourceMetadata {
  return {
    role,
    filename: safeBasename(dbPath),
    schema,
    snapshot: "sqlite-direct",
    wal_present: walPresent(states),
  };
}

/**
 * Rewrites a backup-mode `AppleBooksSourceMetadata` to describe the
 * ORIGINAL Apple-owned source, not the temp `.backup` copy the schema/rows
 * were actually queried from: `filename` and `wal_present` are overridden
 * from the original path and its states (captured immediately before the
 * backup was taken), `snapshot` becomes `"sqlite-backup-file"`, and `role`/
 * `schema` are left as discovered (identical either way, since the backup
 * is a byte-exact copy of the source at capture time). This is required
 * because `sources[]` feeds Reading's fingerprint/identity logic --
 * `backup.sqlite` or any temp path must never leak into it, and switching
 * to backup mode must never look like the source itself changed identity.
 */
function reidentifyBackupSource(source: AppleBooksSourceMetadata, originalDbPath: string, originalStates: FileState[]): AppleBooksSourceMetadata {
  return {
    ...source,
    filename: safeBasename(originalDbPath),
    snapshot: "sqlite-backup-file",
    wal_present: walPresent(originalStates),
  };
}

interface DatabaseReadOutcome {
  annotations: AppleBooksAnnotation[];
  malformed: number;
  source: AppleBooksSourceMetadata;
  libSource: AppleBooksSourceMetadata | null;
}

async function readAnnotationDatabase(
  sqliteProcess: SqliteProcess,
  annotationDbPath: string,
  mode: QueryMode,
  libraryDbPath: string | null,
  fs: AppleBooksFsAdapter,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal | undefined,
): Promise<DatabaseReadOutcome> {
  const schema = await discoverAnnotationSchema(sqliteProcess, annotationDbPath, mode, timeoutMs, maxOutputBytes, signal);
  const { rows, bookRows } = await fetchAnnotationRows(sqliteProcess, annotationDbPath, mode, schema, timeoutMs, maxOutputBytes, signal);
  const bookMap = bookMapFromRows(bookRows);

  let libraryMap = new Map<string, { title: string; author: string | null }>();
  let libSource: AppleBooksSourceMetadata | null = null;
  if (libraryDbPath) {
    const libraryProbe = await fs.probe(libraryDbPath);
    if (libraryProbe.kind === "present") {
      try {
        const librarySchema = await discoverLibrarySchema(sqliteProcess, libraryDbPath, mode, timeoutMs, maxOutputBytes, signal);
        if (librarySchema) {
          libraryMap = await fetchLibraryMap(sqliteProcess, libraryDbPath, mode, librarySchema, timeoutMs, maxOutputBytes, signal);
          const libStates = await fileState(fs, libraryDbPath);
          libSource = sourceMetadata(libraryDbPath, "library", librarySchema.libraryTable, libStates);
        }
      } catch (error) {
        // Cancellation must abort the WHOLE operation, including this optional enrichment step --
        // never silently swallowed. Any other library-only problem (permission denial, a broken
        // schema, a query failure) only degrades enrichment: the annotation read itself still
        // succeeds without book title/author from the library.
        const failure = toReaderFailure(error);
        if (isCancellationFailure(failure)) throw failure;
      }
    }
  }

  const { annotations, malformed } = normalizeAnnotationRows(rows, schema, bookMap, libraryMap);
  const states = await fileState(fs, annotationDbPath);
  return { annotations, malformed, source: sourceMetadata(annotationDbPath, "annotations", schema.annotationTable, states), libSource };
}

function validateBackupDestination(destPath: string, tempDir: string): void {
  if (!destPath.startsWith(`${tempDir}${path.sep}`) && !destPath.startsWith(`${tempDir}/`)) {
    throw new ReaderFailure("unavailable", "APPLE_BOOKS_DATABASE_UNAVAILABLE", "Apple Books backup destination was rejected.", GUIDANCE_OPEN_OR_CONFIGURE);
  }
  if (!SAFE_BACKUP_PATH_PATTERN.test(destPath)) {
    throw new ReaderFailure("unavailable", "APPLE_BOOKS_DATABASE_UNAVAILABLE", "Apple Books backup destination was rejected.", GUIDANCE_OPEN_OR_CONFIGURE);
  }
}

async function backupDatabase(
  sqliteProcess: SqliteProcess,
  fs: AppleBooksFsAdapter,
  sourcePath: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ path: string; tempDir: string }> {
  const tempDir = await fs.mkdtemp(BACKUP_TEMP_PREFIX);
  const destPath = path.join(tempDir, BACKUP_FILE_NAME);
  validateBackupDestination(destPath, tempDir);
  try {
    await sqliteProcess.run({
      script: `.backup ${destPath}\n`,
      extraArgs: ["-readonly", "-batch"],
      dbPath: sourcePath,
      timeoutMs,
      maxOutputBytes: 4096,
      signal,
    });
  } catch (error) {
    await fs.rmDirRecursive(tempDir).catch(() => undefined);
    throw toReaderFailure(error);
  }
  return { path: destPath, tempDir };
}

/**
 * Read-only Apple Books annotation reader. `readAnnotations()` prefers
 * direct queries against the source database, guarded by a before/after
 * stat comparison of the annotation database AND (when a library database
 * is in play) the library database, each including their `-wal`/`-shm`
 * sidecars (`combinedFileState`/`statesEqual`), retried up to
 * `snapshotRetries` times when either source is caught mid-write. If the
 * source never stabilizes -- and the failure classification allows it
 * (`isRecoverableFailure`; see `NON_RECOVERABLE_STATUSES`/`_CODES`) -- it
 * falls back to an isolated read: `.backup` into a plugin-owned `mkdtemp`
 * directory (destination path validated before use), querying the backup
 * copy with the exact same schema-discovery/row-normalization logic, then
 * removing only that owned temp directory. Both paths produce an
 * equivalent normalized `AppleBooksReadResult`.
 *
 * A caller-supplied `AbortSignal` threads through every direct/backup
 * query (including optional library enrichment) and aborts the entire
 * operation -- owned temp directories are still cleaned up via `finally`.
 */
export class AppleBooksSqliteReader {
  private readonly sqliteProcess: SqliteProcess;
  private readonly fs: AppleBooksFsAdapter;
  private readonly config: Record<string, unknown>;
  private readonly homeDirectory: string;
  private readonly annotationDbPathOverride?: string;
  private readonly libraryDbPathOverride?: string;
  private readonly snapshotRetries: number;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: AppleBooksSqliteReaderOptions) {
    const snapshotRetries = options.snapshotRetries ?? DEFAULT_SNAPSHOT_RETRIES;
    if (!Number.isInteger(snapshotRetries) || snapshotRetries < MIN_SNAPSHOT_RETRIES || snapshotRetries > MAX_SNAPSHOT_RETRIES) {
      throw new AppleBooksConfigurationError(`snapshotRetries must be an integer in [${MIN_SNAPSHOT_RETRIES}, ${MAX_SNAPSHOT_RETRIES}].`);
    }
    this.sqliteProcess = options.sqliteProcess;
    this.fs = options.fs;
    this.config = options.config;
    this.homeDirectory = options.homeDirectory;
    this.annotationDbPathOverride = options.annotationDbPath;
    this.libraryDbPathOverride = options.libraryDbPath;
    this.snapshotRetries = snapshotRetries;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  private async discoverPaths(): Promise<{ annotationPath: string | null; libraryPath: string | null }> {
    if (this.annotationDbPathOverride && this.libraryDbPathOverride) {
      return { annotationPath: this.annotationDbPathOverride, libraryPath: this.libraryDbPathOverride };
    }
    const roles = await selectAppleBooksDatabaseRoles({ config: this.config, homeDirectory: this.homeDirectory, fileSystem: this.fs });
    return {
      annotationPath: this.annotationDbPathOverride ?? roles.annotationPath,
      libraryPath: this.libraryDbPathOverride ?? roles.libraryPath,
    };
  }

  async readAnnotations(signal?: AbortSignal): Promise<AppleBooksReadResult> {
    const { annotationPath, libraryPath } = await this.discoverPaths();
    if (!annotationPath) {
      return {
        version: 1,
        status: "unavailable",
        annotations: [],
        diagnostics: [diagnostic("APPLE_BOOKS_DATABASE_UNAVAILABLE", "Apple Books annotation database was not found.", "Open Apple Books or configure apple_books.annotation_database_path, then retry.")],
        count: 0,
      };
    }

    const initialProbe = await this.fs.probe(annotationPath);
    if (initialProbe.kind === "missing") {
      return {
        version: 1,
        status: "unavailable",
        annotations: [],
        diagnostics: [diagnostic("APPLE_BOOKS_DATABASE_UNAVAILABLE", "Apple Books database is unavailable.", GUIDANCE_OPEN_OR_CONFIGURE)],
        count: 0,
      };
    }
    if (initialProbe.kind === "permission-denied") {
      return this.failureResult(
        new ReaderFailure(
          "permission_denied",
          "APPLE_BOOKS_PERMISSION_DENIED",
          "Apple Books database access was denied.",
          GUIDANCE_FULL_DISK_ACCESS,
        ),
      );
    }

    if (signal?.aborted) {
      return this.failureResult(new ReaderFailure("unavailable", "APPLE_BOOKS_SQLITE_CANCELLED", "Apple Books database read was cancelled.", GUIDANCE_OPEN_OR_CONFIGURE));
    }

    let before = await combinedFileState(this.fs, annotationPath, libraryPath);
    for (let attempt = 0; attempt < this.snapshotRetries; attempt += 1) {
      try {
        const outcome = await readAnnotationDatabase(this.sqliteProcess, annotationPath, "direct", libraryPath, this.fs, this.timeoutMs, this.maxOutputBytes, signal);
        const after = await combinedFileState(this.fs, annotationPath, libraryPath);
        if (statesEqual(before, after)) {
          return this.assemblePayload(outcome);
        }
        before = after;
      } catch (error) {
        if (error instanceof ReaderFailure) {
          if (!isRecoverableFailure(error)) {
            return this.failureResult(error);
          }
          before = await combinedFileState(this.fs, annotationPath, libraryPath);
          continue;
        }
        throw error;
      }
    }

    // Direct reads never stabilized (and the instability itself is a recoverable condition) --
    // fall back to an isolated backup copy, which cannot change out from under us once created.
    try {
      // Captured immediately before the backup copy is made -- the most recent known state of the
      // ORIGINAL Apple-owned file. `sources[]` must describe this original identity, never the
      // temp backup.sqlite path/state, since it feeds Reading's fingerprint/identity logic.
      const originalAnnotationStates = await fileState(this.fs, annotationPath);
      const originalLibraryStates = libraryPath ? await fileState(this.fs, libraryPath) : null;

      const backup = await backupDatabase(this.sqliteProcess, this.fs, annotationPath, this.timeoutMs, signal);
      try {
        let libraryBackupPath: string | null = null;
        let libraryBackupDir: string | null = null;
        if (libraryPath && (await this.fs.probe(libraryPath)).kind === "present") {
          try {
            const libBackup = await backupDatabase(this.sqliteProcess, this.fs, libraryPath, this.timeoutMs, signal);
            libraryBackupPath = libBackup.path;
            libraryBackupDir = libBackup.tempDir;
          } catch (error) {
            // Cancellation must still abort the whole operation; any other library-backup
            // failure only loses enrichment for the backup path too.
            const failure = toReaderFailure(error);
            if (isCancellationFailure(failure)) throw failure;
          }
        }
        try {
          const outcome = await readAnnotationDatabase(this.sqliteProcess, backup.path, "backup", libraryBackupPath, this.fs, this.timeoutMs, this.maxOutputBytes, signal);
          const withBackupSnapshot: DatabaseReadOutcome = {
            ...outcome,
            source: reidentifyBackupSource(outcome.source, annotationPath, originalAnnotationStates),
            libSource:
              outcome.libSource && libraryPath && originalLibraryStates
                ? reidentifyBackupSource(outcome.libSource, libraryPath, originalLibraryStates)
                : null,
          };
          return this.assemblePayload(withBackupSnapshot);
        } finally {
          if (libraryBackupDir) await this.fs.rmDirRecursive(libraryBackupDir).catch(() => undefined);
        }
      } finally {
        await this.fs.rmDirRecursive(backup.tempDir).catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof ReaderFailure) {
        return this.failureResult(error);
      }
      return this.failureResult(
        new ReaderFailure("source_changing", "APPLE_BOOKS_DATABASE_CHANGING", "Apple Books database changed while a read snapshot was being created.", "Retry after Apple Books finishes updating its annotations."),
      );
    }
  }

  async checkAccess(signal?: AbortSignal): Promise<Omit<AppleBooksReadResult, "annotations"> & { annotations?: never }> {
    const result = await this.readAnnotations(signal);
    const safe: Omit<AppleBooksReadResult, "annotations"> = {
      version: result.version,
      status: result.status,
      count: result.count,
      diagnostics: result.diagnostics,
      ...(result.skipped_rows !== undefined ? { skipped_rows: result.skipped_rows } : {}),
      ...(result.sources !== undefined ? { sources: result.sources } : {}),
    };
    return safe;
  }

  private assemblePayload(outcome: DatabaseReadOutcome): AppleBooksReadResult {
    const sources = outcome.libSource ? [outcome.source, outcome.libSource] : [outcome.source];
    if (outcome.malformed > 0) {
      const status: AppleBooksReadStatus = outcome.annotations.length > 0 ? "partial" : "malformed_rows";
      return {
        version: 1,
        status,
        annotations: outcome.annotations,
        diagnostics: [
          diagnostic(
            "APPLE_BOOKS_MALFORMED_ROWS",
            `Skipped ${outcome.malformed} malformed Apple Books annotation row(s).`,
            "Valid annotations remain usable. Retry after Apple Books finishes updating; if the issue persists, report an unsupported schema.",
            "warning",
          ),
        ],
        count: outcome.annotations.length,
        skipped_rows: outcome.malformed,
        sources,
      };
    }
    return {
      version: 1,
      status: "success",
      annotations: outcome.annotations,
      diagnostics: [],
      count: outcome.annotations.length,
      sources,
    };
  }

  private failureResult(failure: ReaderFailure): AppleBooksReadResult {
    return {
      version: 1,
      status: failure.status,
      annotations: [],
      diagnostics: [diagnostic(failure.code, failure.message, failure.guidance)],
      count: 0,
    };
  }
}
