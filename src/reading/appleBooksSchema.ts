/**
 * Pure, subprocess-free schema/table/column discovery and row/value
 * normalization -- ports the equivalent helpers from
 * python/apple_books_reader.py (`_quote_identifier`, `_find_table`,
 * `_columns`, `_column`, `_text`, `_timestamp`, `_author_from_row`,
 * `_library_map`'s row-mapping, `_read_annotation_rows`'s row-mapping) as
 * a behavioral port, not a line-by-line translation. Every function here
 * operates on already-fetched plain JS values; nothing in this module
 * spawns a process or touches a filesystem.
 */

const CF_EPOCH_SECONDS = 978307200;
const MAX_TIMESTAMP_SECONDS = 4_000_000_000;

/** Apple's Core Data `Z_PK`/`rowid` epoch offset applied before ISO conversion; kept as a named export so the SQL-fragment builder and the orchestrator can both reference it without a magic number. */
export const APPLE_CF_EPOCH_SECONDS = CF_EPOCH_SECONDS;

/** SQL double-quoted identifier, doubling any embedded `"` -- mirrors `_quote_identifier` exactly. Never used with a user-controlled/unbounded name; only ever with one of this module's own fixed candidate table/column name constants. */
export function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Mirrors `_find_table`: prefers an exact (case-insensitive) match from
 * `preferred`, in order; falls back to the first table (alphabetical by
 * uppercase) whose name contains `contains` (case-insensitive) when given.
 * `null` when nothing matches.
 */
export function findTable(tableNames: readonly string[], preferred: readonly string[], contains?: string): string | null {
  const byUpper = new Map<string, string>();
  for (const table of tableNames) {
    byUpper.set(table.toUpperCase(), table);
  }
  for (const name of preferred) {
    const match = byUpper.get(name.toUpperCase());
    if (match !== undefined) return match;
  }
  if (contains) {
    const needle = contains.toUpperCase();
    const matches = tableNames.filter((table) => table.toUpperCase().includes(needle)).sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase()));
    return matches[0] ?? null;
  }
  return null;
}

/** Uppercased column-name set from a `PRAGMA table_info` result (rows shaped `{ name: string }`, as produced by the SQL fragment this module builds). Mirrors `_columns`. */
export function columnSetFromPragma(rows: readonly { name?: unknown }[]): Set<string> {
  const columns = new Set<string>();
  for (const row of rows) {
    if (typeof row.name === "string") {
      columns.add(row.name.toUpperCase());
    }
  }
  return columns;
}

/** First of `names` (in order) present in `columns`, case-insensitively; `null` if none are. Mirrors `_column`. */
export function pickColumn(columns: ReadonlySet<string>, ...names: string[]): string | null {
  for (const name of names) {
    const upper = name.toUpperCase();
    if (columns.has(upper)) return upper;
  }
  return null;
}

/**
 * A value plus its SQLite storage class (`typeof(...)`: `"null"`,
 * `"integer"`, `"real"`, `"text"`, or `"blob"`), exactly as this module's
 * SQL-fragment builder (`typedValueJsonFragment`) produces for every field
 * this reader validates. Unlike a native `sqlite3` driver (which surfaces a
 * BLOB as a distinct `Buffer`/`bytes` type), the `sqlite3` CLI's `-json`/
 * `json_object()` output collapses everything to JSON types -- carrying
 * `type` alongside `value` is what lets `parseText`/`parseTimestamp` still
 * reject a BLOB column exactly like `_text`/`_timestamp` do in Python.
 */
export type SqliteStorageClass = "null" | "integer" | "real" | "text" | "blob";

export interface TypedValue {
  value: unknown;
  type: SqliteStorageClass;
}

/** SQL fragment for one field of a `json_object(...)` row projection: `'alias', json_object('value', <expr>, 'type', typeof(<expr>))`. `expr` should already be a quoted identifier (or a small SQL expression over one). */
export function typedValueJsonFragment(alias: string, expr: string): string {
  // SQLite's json_object()/json_array() refuse a raw BLOB argument outright ("JSON cannot hold
  // BLOB values") rather than converting it -- which would abort the entire query the moment any
  // single row held a BLOB in a validated column. hex()-encoding the value only when typeof(expr)
  // is 'blob' keeps every row queryable while 'type' still reports the column's real storage
  // class (typeof() is applied to the original, unwrapped expr), so parseText/parseTimestamp still
  // see type: "blob" and reject it exactly like _text()/_timestamp() reject a non-str/int/float
  // value in Python -- the hex string itself is never treated as valid text.
  return `'${alias}', json_object('value', CASE WHEN typeof(${expr}) = 'blob' THEN hex(${expr}) ELSE ${expr} END, 'type', typeof(${expr}))`;
}

export class SchemaValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValueError";
  }
}

/**
 * Mirrors `_text`: `null`/absent -> `null` (or throws if `required`); a
 * BLOB or any non-(null/integer/real/text) storage class is rejected
 * (matches Python rejecting non-`(str, int, float)` types); NUL bytes are
 * stripped; the result is trimmed and empty strings become `null` (or
 * throw if `required`).
 */
export function parseText(typed: TypedValue | undefined, field: string, required = false): string | null {
  if (typed === undefined || typed.type === "null" || typed.value === null || typed.value === undefined) {
    if (required) throw new SchemaValueError(`missing ${field}`);
    return null;
  }
  if (typed.type !== "text" && typed.type !== "integer" && typed.type !== "real") {
    throw new SchemaValueError(`invalid ${field}`);
  }
  // typed.type has already been narrowed to "text" | "integer" | "real", so the runtime value is
  // guaranteed to be a string or number (never an object with a meaningless default toString).
  const stringValue = typeof typed.value === "number" ? typed.value.toString() : (typed.value as string);
  // eslint-disable-next-line no-control-regex -- intentionally strips NUL bytes, mirroring Python's str.replace("\x00", "")
  const result = stringValue.replace(/\u0000/g, "").trim();
  if (required && !result) {
    throw new SchemaValueError(`empty ${field}`);
  }
  return result || null;
}

/**
 * Mirrors `_timestamp`: Apple's Core Foundation absolute-time seconds
 * (offset from `APPLE_CF_EPOCH_SECONDS`, i.e. 2001-01-01T00:00:00Z)
 * converted to a UTC ISO-8601 string ending in `Z`. `null`/empty-string ->
 * `null`; a non-numeric or out-of-bounds value throws.
 */
export function parseTimestamp(typed: TypedValue | undefined, field: string): string | null {
  if (typed === undefined || typed.type === "null" || typed.value === null || typed.value === undefined || typed.value === "") {
    return null;
  }
  if (typed.type !== "integer" && typed.type !== "real" && typed.type !== "text") {
    throw new SchemaValueError(`invalid ${field}`);
  }
  const seconds = typeof typed.value === "number" ? typed.value : Number(typed.value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_TIMESTAMP_SECONDS) {
    throw new SchemaValueError(`invalid ${field}`);
  }
  const millis = (seconds + CF_EPOCH_SECONDS) * 1000;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) {
    throw new SchemaValueError(`invalid ${field}`);
  }
  return date.toISOString().replace(/\.000Z$/, "Z");
}

/** Mirrors `_author_from_row`: prefers a direct author column; otherwise composes "Given Family" from separate family/given-name columns, falling back to whichever half is present. */
export function authorFromRow(fields: { author?: TypedValue; familyName?: TypedValue; givenName?: TypedValue }): string | null {
  const direct = parseText(fields.author, "author");
  if (direct) return direct;
  const family = parseText(fields.familyName, "author");
  const given = parseText(fields.givenName, "author");
  if (family && given) return `${given} ${family}`;
  return family || given || null;
}

export const ANNOTATION_TABLE_CANDIDATES = ["ZAEANNOTATION", "ZANNOTATION"] as const;
export const ANNOTATION_TABLE_CONTAINS = "ANNOTATION";
export const BOOK_TABLE_CANDIDATES = ["ZAEBOOK", "ZBOOK"] as const;
export const BOOK_TABLE_CONTAINS = "BOOK";
export const LIBRARY_TABLE_CANDIDATES = ["ZBKLIBRARYASSET"] as const;
export const LIBRARY_TABLE_CONTAINS = "BKLIBRARYASSET";

export const ANNOTATION_IDENTITY_COLUMNS = ["ZANNOTATIONUUID", "ZUUID", "ZANNOTATIONID", "Z_PK"] as const;
export const ANNOTATION_QUOTE_COLUMNS = ["ZANNOTATIONSELECTEDTEXT", "ZANNOTATIONREPRESENTATIVETEXT"] as const;
export const ANNOTATION_NOTE_COLUMNS = ["ZANNOTATIONNOTE"] as const;
export const ANNOTATION_CHAPTER_COLUMNS = ["ZANNOTATIONCHAPTER", "ZFUTUREPROOFING5"] as const;
export const ANNOTATION_LOCATION_COLUMNS = ["ZPLLOCATIONRANGESTART", "ZANNOTATIONLOCATION"] as const;
export const ANNOTATION_CREATED_COLUMNS = ["ZCREATIONDATE", "ZANNOTATIONCREATIONDATE"] as const;
export const ANNOTATION_MODIFIED_COLUMNS = ["ZMODIFICATIONDATE", "ZANNOTATIONMODIFICATIONDATE", "ZLASTMODIFICATIONDATE"] as const;
export const ANNOTATION_BOOK_FK_COLUMNS = ["ZANNOTATIONBOOK"] as const;
export const ANNOTATION_ASSET_COLUMNS = ["ZANNOTATIONASSETID"] as const;

export const BOOK_TITLE_COLUMNS = ["ZTITLE"] as const;
export const AUTHOR_COLUMNS = ["ZAUTHOR"] as const;
export const AUTHOR_FAMILY_COLUMNS = ["ZAUTHORFAMILYNAME"] as const;
export const AUTHOR_GIVEN_COLUMNS = ["ZAUTHORGIVENNAME"] as const;

export const LIBRARY_ASSET_ID_COLUMNS = ["ZASSETID"] as const;
