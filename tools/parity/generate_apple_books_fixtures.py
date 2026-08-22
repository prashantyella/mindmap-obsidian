#!/usr/bin/env python3
"""Development-only fixture generator for the TypeScript Apple Books SQLite
reader's parity corpus (tests/fixtures/apple-books/). Imports
python/apple_books_reader.py and tests/fixtures/apple_books_fixture.py
directly and records the Python oracle's normalized output for each
synthetic SQLite fixture shape as deterministic JSON.

Not part of the shipped product: never imported by python/apple_books_reader.py
or anything reachable from main.ts/the esbuild bundle. Run by hand during
development only; every fixture DB is built fresh in a temp directory, never
touching a real vault or real Apple Books data.

Usage: python3 tools/parity/generate_apple_books_fixtures.py
"""

import hashlib
import json
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "python"))
sys.path.insert(0, str(REPO_ROOT / "tests" / "fixtures"))

import apple_books_reader  # noqa: E402
from apple_books_fixture import build_fixture  # noqa: E402

FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures" / "apple-books"
ORACLE_FILE = "python/apple_books_reader.py"
FIXTURE_SCHEMA_VERSION = 1


def oracle_sha256() -> str:
    return hashlib.sha256((REPO_ROOT / ORACLE_FILE).read_bytes()).hexdigest()


def write_fixture(name: str, payload) -> None:
    provenance = {
        "fixtureSchemaVersion": FIXTURE_SCHEMA_VERSION,
        "pythonOracleFile": ORACLE_FILE,
        "pythonOracleSha256": oracle_sha256(),
        "generator": "tools/parity/generate_apple_books_fixtures.py",
    }
    full_payload = {"provenance": provenance, **payload}
    path = FIXTURES_DIR / name
    path.write_text(json.dumps(full_payload, indent=2, sort_keys=False, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(REPO_ROOT)}")


def normalize(result: dict) -> dict:
    """Strips nothing path-dependent (annotation DB fixtures are always named
    AEAnnotation.sqlite/BKLibrary.sqlite by build_fixture, so `sources[].filename`
    is already deterministic) -- returns the reader's own JSON-serializable result
    unchanged, so a TS-side comparison can diff it directly."""
    return result


def case(name: str, shape: str, **kwargs) -> dict:
    with tempfile.TemporaryDirectory() as temp:
        annotation, library = build_fixture(Path(temp), shape, **kwargs)
        library_path = library if shape == "asset-enriched" else None
        # `home` MUST be set to the isolated temp directory: ReaderConfig without an explicit
        # library_db_path falls back to well-known real Apple Books paths under the caller's
        # actual $HOME, which would make this dev-only fixture generator silently read real
        # user Apple Books library data on a machine that has any. Pointing `home` at a fresh
        # temp dir (which has no Library/... subtree) guarantees that fallback finds nothing.
        config = apple_books_reader.ReaderConfig(annotation_db_path=annotation, library_db_path=library_path, home=Path(temp))
        result = apple_books_reader.read_annotations(config)
        return {"name": name, "shape": shape, "options": kwargs, "result": normalize(result)}


def main() -> None:
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    cases = [
        case("joined schema, no options", "joined"),
        case("joined schema, malformed", "joined", malformed=True),
        case("joined schema, partial", "joined", partial=True),
        case("asset-enriched schema with library enrichment", "asset-enriched"),
        case("unsupported schema", "unsupported"),
    ]
    write_fixture("reader_payloads.json", {"cases": cases})


if __name__ == "__main__":
    main()
