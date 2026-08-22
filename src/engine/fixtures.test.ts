import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const REPO_ROOT = path.resolve(__dirname, "../..");
const FIXTURES_DIR = path.join(REPO_ROOT, "tests", "fixtures", "engine");
const PYTHON_ORACLE_FILE = path.join(REPO_ROOT, "python", "mindmap.py");

const EXPECTED_FIXTURE_FILES = [
  "frontmatter.json",
  "related_section.json",
  "chunking.json",
  "normalization.json",
  "related_selection.json",
  "individual_note_eligibility.json",
  "apple_annotation_wikilinks.json",
  "preview_validation.json",
  "diagnostics.json",
];

const FORBIDDEN_CONTENT_PATTERNS = [/\/Users\//, /\/var\/folders\//, /\breal-vault\b/i];

interface FixtureProvenance {
  fixtureSchemaVersion: number;
  pythonOracleFile: string;
  pythonOracleSha256: string;
  generator: string;
}

interface FixtureFile {
  provenance: FixtureProvenance;
  cases: Array<Record<string, unknown>>;
}

function loadFixture(fileName: string): FixtureFile {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, fileName), "utf8");
  return JSON.parse(raw) as FixtureFile;
}

void test("every required Checkpoint 1 fixture file exists and captures at least one case", () => {
  for (const fileName of EXPECTED_FIXTURE_FILES) {
    const fixture = loadFixture(fileName);
    assert.ok(Array.isArray(fixture.cases), `${fileName} must have a "cases" array`);
    assert.ok(fixture.cases.length > 0, `${fileName} must have at least one case`);
    for (const testCase of fixture.cases) {
      assert.equal(typeof testCase.name, "string", `${fileName} case is missing a string "name"`);
      assert.ok((testCase.name as string).length > 0, `${fileName} case has an empty "name"`);
    }
  }
});

void test("every fixture records provenance identifying the exact python/mindmap.py oracle it was captured against", () => {
  for (const fileName of EXPECTED_FIXTURE_FILES) {
    const fixture = loadFixture(fileName);
    assert.ok(fixture.provenance, `${fileName} is missing a "provenance" field`);
    assert.equal(fixture.provenance.fixtureSchemaVersion, 1, `${fileName} provenance.fixtureSchemaVersion mismatch`);
    assert.equal(fixture.provenance.pythonOracleFile, "python/mindmap.py", `${fileName} provenance.pythonOracleFile mismatch`);
    assert.equal(fixture.provenance.generator, "tools/parity/generate_fixtures.py", `${fileName} provenance.generator mismatch`);
    assert.match(fixture.provenance.pythonOracleSha256, /^[0-9a-f]{64}$/, `${fileName} provenance.pythonOracleSha256 is not a 64-character hex hash`);
  }
});

void test("every fixture's recorded pythonOracleSha256 matches the current python/mindmap.py bytes (catches stale, unregenerated fixtures)", () => {
  // Reads and hashes the oracle file's bytes with node:crypto — this never executes Python.
  const actualHash = createHash("sha256").update(fs.readFileSync(PYTHON_ORACLE_FILE)).digest("hex");
  for (const fileName of EXPECTED_FIXTURE_FILES) {
    const fixture = loadFixture(fileName);
    assert.equal(
      fixture.provenance.pythonOracleSha256,
      actualHash,
      `${fileName} was generated against a different python/mindmap.py than the one currently in the repo; regenerate the engine fixture corpus via the parity generator script`,
    );
  }
});

void test("fixtures are byte-deterministic: re-serializing the parsed JSON round-trips identically", () => {
  for (const fileName of EXPECTED_FIXTURE_FILES) {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, fileName), "utf8");
    const reserialized = `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
    assert.equal(reserialized, raw, `${fileName} is not canonically formatted/deterministic`);
  }
});

void test("fixtures contain no real vault paths, temp-directory leakage, or secrets", () => {
  for (const fileName of EXPECTED_FIXTURE_FILES) {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, fileName), "utf8");
    for (const pattern of FORBIDDEN_CONTENT_PATTERNS) {
      assert.doesNotMatch(raw, pattern, `${fileName} matched forbidden pattern ${pattern}`);
    }
  }
});

void test("chunking fixture ordering is deterministic across repeated reads", () => {
  const first = loadFixture("chunking.json");
  const second = loadFixture("chunking.json");
  assert.deepEqual(first, second);
});

void test("related_selection fixture: core selection excludes self and orders by descending score", () => {
  const fixture = loadFixture("related_selection.json");
  const tieCase = fixture.cases.find((c) => c.name === "select_mindmap_links excludes self and preserves input order on score ties");
  assert.ok(tieCase);
  const output = tieCase!.output as [string, string][];
  assert.deepEqual(output.map((entry) => entry[0]), ["Notes/X.md", "Notes/Y.md"]);
  assert.ok(output.every(([pathValue]) => pathValue !== "Notes/Self.md"));
});

void test("individual_note_eligibility fixture: Apple annotation minimum overrides configured minimum", () => {
  const fixture = loadFixture("individual_note_eligibility.json");
  const annotationCase = fixture.cases.find((c) => c.name === "Apple annotation note uses the fixed 8-word minimum regardless of configured minimum");
  assert.ok(annotationCase);
  assert.equal(annotationCase!.minimum_words_for_note, 8);
  assert.equal(annotationCase!.meets_minimum, true);
});

void test("preview_validation fixture: every non-null issue carries a code and message", () => {
  const fixture = loadFixture("preview_validation.json");
  for (const testCase of fixture.cases) {
    const issue = testCase.issue as Record<string, unknown> | null;
    if (issue === null) continue;
    assert.equal(typeof issue.code, "string");
    assert.equal(typeof issue.message, "string");
  }
});
