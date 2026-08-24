import test from "node:test";
import assert from "node:assert/strict";

import {
  authorFromRow,
  columnSetFromPragma,
  findTable,
  parseText,
  parseTimestamp,
  pickColumn,
  quoteSqlIdentifier,
  SchemaValueError,
  type TypedValue,
} from "./appleBooksSchema";

function text(value: string): TypedValue {
  return { value, type: "text" };
}
function integer(value: number): TypedValue {
  return { value, type: "integer" };
}
function real(value: number): TypedValue {
  return { value, type: "real" };
}
function blob(value: string): TypedValue {
  return { value, type: "blob" };
}
function nullValue(): TypedValue {
  return { value: null, type: "null" };
}

void test("quoteSqlIdentifier wraps in double quotes and doubles embedded quotes", () => {
  assert.equal(quoteSqlIdentifier("ZTITLE"), '"ZTITLE"');
  assert.equal(quoteSqlIdentifier('weird"name'), '"weird""name"');
});

void test("findTable prefers an exact case-insensitive match from the preferred list, in order", () => {
  assert.equal(findTable(["zannotation", "ZAEANNOTATION"], ["ZAEANNOTATION", "ZANNOTATION"]), "ZAEANNOTATION");
  assert.equal(findTable(["ZANNOTATION"], ["ZAEANNOTATION", "ZANNOTATION"]), "ZANNOTATION");
});

void test("findTable falls back to a contains match, alphabetically first, when nothing preferred exists", () => {
  assert.equal(findTable(["ZOTHER", "ZFOOANNOTATIONBAR", "ZAANNOTATIONX"], [], "ANNOTATION"), "ZAANNOTATIONX");
});

void test("findTable returns null when nothing matches", () => {
  assert.equal(findTable(["ZUNRELATED"], ["ZAEANNOTATION"], "ANNOTATION"), null);
});

void test("columnSetFromPragma uppercases names and ignores non-string entries", () => {
  const set = columnSetFromPragma([{ name: "zTitle" }, { name: "ZAuthor" }, { name: 5 }, {}]);
  assert.deepEqual([...set].sort(), ["ZAUTHOR", "ZTITLE"]);
});

void test("pickColumn returns the first present candidate, case-insensitively", () => {
  const columns = new Set(["ZAUTHOR"]);
  assert.equal(pickColumn(columns, "ZMISSING", "zauthor"), "ZAUTHOR");
  assert.equal(pickColumn(columns, "ZNOPE"), null);
});

void test("parseText returns null for absent/null values and throws when required", () => {
  assert.equal(parseText(undefined, "field"), null);
  assert.equal(parseText(nullValue(), "field"), null);
  assert.throws(() => parseText(undefined, "field", true), SchemaValueError);
  assert.throws(() => parseText(nullValue(), "field", true), SchemaValueError);
});

void test("parseText accepts text/integer/real and rejects blob (mirrors Python rejecting non-str/int/float)", () => {
  assert.equal(parseText(text("hello"), "field"), "hello");
  assert.equal(parseText(integer(42), "field"), "42");
  assert.equal(parseText(real(1.5), "field"), "1.5");
  assert.throws(() => parseText(blob("bad"), "field"), SchemaValueError);
});

void test("parseText strips NUL bytes and trims, treating an empty result as null (or throwing if required)", () => {
  assert.equal(parseText(text("  padded  "), "field"), "padded");
  assert.equal(parseText(text("  "), "field"), null);
  assert.throws(() => parseText(text("   "), "field", true), SchemaValueError);
});

void test("parseTimestamp converts Apple CF-epoch seconds to a UTC ISO-8601 string ending in Z", () => {
  // 0 CF-epoch seconds == 2001-01-01T00:00:00Z
  assert.equal(parseTimestamp(real(0), "field"), "2001-01-01T00:00:00Z");
  assert.equal(parseTimestamp(real(100000000), "field"), new Date((100000000 + 978307200) * 1000).toISOString().replace(/\.000Z$/, "Z"));
});

void test("parseTimestamp returns null for null/empty and throws for out-of-range or non-numeric values", () => {
  assert.equal(parseTimestamp(undefined, "field"), null);
  assert.equal(parseTimestamp(nullValue(), "field"), null);
  assert.equal(parseTimestamp(text(""), "field"), null);
  assert.throws(() => parseTimestamp(real(-1), "field"), SchemaValueError);
  assert.throws(() => parseTimestamp(real(5_000_000_000), "field"), SchemaValueError);
  assert.throws(() => parseTimestamp(text("not-a-number"), "field"), SchemaValueError);
  assert.throws(() => parseTimestamp(blob("x"), "field"), SchemaValueError);
});

void test("authorFromRow prefers a direct author column over family/given composition", () => {
  assert.equal(authorFromRow({ author: text("A. Reader"), familyName: text("Ignored"), givenName: text("Ignored") }), "A. Reader");
});

void test("authorFromRow composes 'Given Family' when only family/given columns are present", () => {
  assert.equal(authorFromRow({ familyName: text("Writer"), givenName: text("B.") }), "B. Writer");
});

void test("authorFromRow falls back to whichever half of family/given is present alone", () => {
  assert.equal(authorFromRow({ familyName: text("Writer") }), "Writer");
  assert.equal(authorFromRow({ givenName: text("B.") }), "B.");
  assert.equal(authorFromRow({}), null);
});
