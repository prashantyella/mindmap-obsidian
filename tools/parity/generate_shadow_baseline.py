#!/usr/bin/env python3
"""Dev-only ShadowBaselineV1 generator for Checkpoint 9's TS-vs-Python
shadow comparison. Uses python/mindmap.py itself as the ORACLE -- the
exact same `list_notes()` / `chunk_text()` / `note_meets_minimum()` /
`parse_frontmatter()` functions production's Python path already calls,
never a reimplementation -- run over a real, developer-supplied vault.

Writes a strict, redacted `ShadowBaselineV1` JSON file (see
`src/engine/shadowEngine.ts`'s `parseShadowBaselineV1`): hashed ids,
counts, and closed status codes only. NEVER note text, a raw vault-
relative path, a provider response body, a secret/credential, or a
vector value. `hashedId` is a one-way sha256 digest of the SAME
`"path:<canonicalPath>"` / `"apple-annotation:<id>"` scheme
`shadowEngine.ts`'s own `hashIdentity` uses -- the vault-relative path
itself is fed only into `hashlib.sha256(...)`, never written to the
output file in the clear.

Populates a MEANINGFUL, genuinely-comparable output digest per entry, not
just identity/eligibility: `projectionDigest` is sha256 of the Python
oracle's own normalized `Note.body` (post `parse_frontmatter` +
`strip_related_section` -- the SAME normalized body `list_notes`/
`chunk_text` themselves operate on), and `chunkBoundaryDigest` is sha256
of the comma-joined per-chunk sha256 digests of that same body's chunks
-- see `digest_text`/`chunk_content_digest` below, and
`shadowEngine.ts`'s own `digestText`/`chunkContentDigest`, which use the
byte-for-byte identical formula. This is deliberately NOT a
reimplementation of `sourceProjection.ts`'s managed-frontmatter-key/
managed-related-section stripping -- the whole point of this generator is
to compare the Python ORACLE's independent output against TS's, so any
divergence between the two normalization paths is a genuine signal, not
noise to be engineered away.

`relatedNonEmpty`/`relatedCandidateHashedIds` (would require a live
embedding/related-query pass) and `appleReader` (populated only when
`--with-apple` is explicitly passed, see below) stay conditional --
`ShadowBaselineV1` keeps both OPTIONAL, and `runShadowComparison` treats
an omitted optional field as "no sub-comparison for this domain", never a
fabricated agreement (see `ShadowComparisonAvailabilityV1`).

Not part of the shipped product: never imported by python/mindmap.py or
python/mindmap_worker.py, never reachable from src/ or the esbuild bundle
(see src/engine/parityToolIsolation.test.ts and the production dist
audit in scripts/validate-release.mjs, both of which check for this).
Run by hand during development only.

Usage:
    python3 tools/parity/generate_shadow_baseline.py \\
        --vault-root /path/to/your/dev/vault \\
        --config /path/to/plugin/data/config.json \\
        --output /path/to/plugin/data/mindmap-engine/shadow-baseline.json

The output path should point at the SAME plugin-owned
`<pluginDir>/data/mindmap-engine/shadow-baseline.json` path
`src/engine/devShadowIntegration.ts`'s dev command reads from.
"""

import argparse
import datetime
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "python"))

import mindmap  # noqa: E402

BASELINE_SCHEMA_VERSION = 1
DEFAULT_RELATED_HEADING = "## Mindmap"
DEFAULT_MIN_WORDS = 30
DEFAULT_CHUNK_TARGET_TOKENS = 400
DEFAULT_CHUNK_OVERLAP_TOKENS = 40
# Mirrors shadowEngine.ts's MAX_SHADOW_SAMPLE_NOTES exactly -- this generator's `sampleCount` is
# defined as "however many notes THIS bounded pass processed", the same population TS's own
# metrics.sampleSize is capped to (Checkpoint 9 closure review item 2/8: sampleCount must compare
# like-for-like, never a capped TS sample against an unrelated whole-vault Python total).
MAX_SAMPLE_COUNT = 50


def normalize_newlines_for_digest(text: str) -> str:
    """Matches shadowEngine.ts's `normalizeNewlinesForDigest` exactly: CRLF and lone CR both
    collapse to LF before hashing, so a note's on-disk line-ending convention (which Python's own
    `Path.read_text()` already normalizes, unlike TS's raw byte read) can never produce a spurious
    cross-language digest mismatch."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def digest_text(text: str) -> str:
    """sha256 hex digest of `text`, newline-normalized first -- the one digest primitive every
    hash in this module is built from, byte-for-byte identical to shadowEngine.ts's `digestText`."""
    return hashlib.sha256(normalize_newlines_for_digest(text).encode("utf-8")).hexdigest()


def chunk_content_digest(chunks: List[str]) -> str:
    """sha256 of the comma-joined per-chunk sha256 digests -- matches shadowEngine.ts's
    `chunkContentDigest` exactly: `digestText(chunks.map(digestText).join(","))`. Reveals whether
    chunk BOUNDARIES/content agree without ever exposing chunk text itself: each `digest_text(chunk)`
    is one-way, and this function only compares the joined sequence of those one-way digests."""
    return digest_text(",".join(digest_text(chunk) for chunk in chunks))


def hashed_id_for(relpath: str, annotation_id: Optional[str]) -> str:
    """The exact same hashing scheme as shadowEngine.ts's `hashIdentity` -- sha256 of
    `"path:<canonicalPath>"` or `"apple-annotation:<id>"`. The vault-relative path is consumed
    only as input to the digest; it is never itself written to the output."""
    key = f"apple-annotation:{annotation_id}" if annotation_id is not None else f"path:{relpath}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def canonical_generated_at_iso() -> str:
    """Matches shadowEngine.ts's CANONICAL_ISO_PATTERN exactly: `YYYY-MM-DDTHH:mm:ss.sssZ`."""
    now = datetime.datetime.now(datetime.timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def scan_reading_annotations(vault_root: Path, min_words: int) -> List["mindmap.Note"]:
    """Scans ONLY structurally valid Apple annotation paths under the Reading root --
    `Books/Apple Books/<author>/<book>/Annotations/<note>.md` via `mindmap.is_reading_annotation_relpath`
    (the SAME structural-shape oracle function `mindmap.py`'s own state/vector-row cleanup uses) --
    never an arbitrary ordinary note anywhere else under `Books/Apple Books` (Checkpoint 9
    parity-signal correction item 2, matching `vaultCatalogPlanner.ts`'s own
    `isStructurallyValidAnnotationPath` exactly: only this one shape is admitted through the
    Reading-only path)."""
    reading_root = vault_root / mindmap.READING_NOTES_ROOT
    if not reading_root.is_dir():
        return []
    notes: List[mindmap.Note] = []
    for path in reading_root.rglob("*.md"):
        relpath = path.relative_to(vault_root).as_posix()
        if not mindmap.is_reading_annotation_relpath(relpath):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        frontmatter, body = mindmap.parse_frontmatter(text)
        if not mindmap.frontmatter_is_apple_annotation(frontmatter):
            continue
        body = mindmap.strip_related_section(body, DEFAULT_RELATED_HEADING)
        if not mindmap.note_meets_minimum(text, frontmatter, min_words, body=body):
            continue
        notes.append(mindmap.Note(path=path, relpath=relpath, title=path.stem, body=body, is_apple_annotation=True))
    return notes


def build_entries(vault_root: Path, config: Dict) -> List[Dict]:
    notes_paths = config.get("notes_paths_current") or config.get("notes_paths") or []
    if not isinstance(notes_paths, list):
        notes_paths = []
    min_words = int(config.get("min_note_words", DEFAULT_MIN_WORDS))
    target_tokens = int(config.get("chunk_target_tokens", DEFAULT_CHUNK_TARGET_TOKENS))
    overlap_tokens = int(config.get("chunk_overlap_tokens", DEFAULT_CHUNK_OVERLAP_TOKENS))

    # `list_notes` IS the oracle for the ORDINARY note universe: the exact function production's
    # own scheduled/manual runs call, including its own generated-Reading-index exclusion and
    # minimum-word enforcement -- never a parallel reimplementation of that logic here.
    # `include_reading_annotations=False` (its own default) means an annotation note found while
    # walking an overlapping ordinary scope path is NOT included from this pass -- annotations are
    # sourced exclusively from `scan_reading_annotations` below, which enforces the STRICT
    # structural shape (mirrors devShadowIntegration.ts's own separation: ordinary scope vs. the
    # always-included, strictly-shaped Reading-annotation path).
    ordinary_notes = mindmap.list_notes(vault_root, notes_paths, min_words, DEFAULT_RELATED_HEADING, include_reading_annotations=False)
    annotation_notes = scan_reading_annotations(vault_root, min_words)

    # Deduplicate by canonical relpath BEFORE sorting/capping (Checkpoint 9 parity-signal
    # correction item 2): `list_notes` walks each of `notes_paths` independently, so overlapping
    # configured paths (e.g. "." and "Notes") could otherwise yield the same relpath twice. A dict
    # keyed by relpath keeps exactly one Note per path, first-seen-wins (ordinary before
    # annotation, though in practice `is_reading_annotation_relpath`'s strict shape and
    # `include_reading_annotations=False` above make an actual collision between the two lists
    # extremely unlikely).
    by_relpath: Dict[str, mindmap.Note] = {}
    for note in ordinary_notes + annotation_notes:
        by_relpath.setdefault(note.relpath, note)

    # Deterministic canonical-path sort BEFORE sampling -- mirrors vaultCatalogPlanner.ts's own
    # "sort before sampling" contract exactly, so both sides bound to the SAME first-N notes.
    notes = sorted(by_relpath.values(), key=lambda note: note.relpath)[:MAX_SAMPLE_COUNT]

    entries: List[Dict] = []
    for note in notes:
        annotation_id: Optional[str] = None
        if note.is_apple_annotation:
            text = note.path.read_text(encoding="utf-8", errors="ignore")
            frontmatter, _body = mindmap.parse_frontmatter(text)
            raw_id = frontmatter.get("annotation_id")
            if isinstance(raw_id, str) and raw_id.strip():
                annotation_id = raw_id.strip()
            else:
                # Mirrors vaultCatalogPlanner.ts's own MISSING_ANNOTATION_ID skip -- an annotation
                # note without a real scalar nonblank id is never included in the baseline.
                continue

        chunks = mindmap.chunk_text(note.body, target_tokens, overlap_tokens)
        entries.append({
            "hashedId": hashed_id_for(note.relpath, annotation_id),
            "eligible": True,
            # Meaningful, genuinely-comparable Python oracle output (Checkpoint 9 parity-signal
            # correction item 1) -- see this module's docstring and shadowEngine.ts's own
            # `digestText`/`chunkContentDigest` for the EXACT shared formula both languages use:
            # projectionDigest = sha256(normalize_newlines_for_digest(note.body)); chunkBoundaryDigest
            # = sha256(",".join(sha256(chunk) for chunk in chunks)).
            "projectionDigest": digest_text(note.body),
            "chunkCount": len(chunks),
            "chunkBoundaryDigest": chunk_content_digest(chunks),
        })
    return entries


def write_baseline_atomically(output_path: Path, baseline: Dict) -> None:
    """Temp file in the SAME directory, then `os.replace` (atomic rename on the same filesystem)
    -- never a partially-written baseline file left behind by an interrupted run."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=str(output_path.parent), prefix=".shadow-baseline-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(baseline, handle, indent=2, sort_keys=True, ensure_ascii=True)
            handle.write("\n")
        os.replace(tmp_path, str(output_path))
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def build_apple_reader(annotation_db: Optional[Path], library_db: Optional[Path]) -> Dict:
    """Checkpoint 9 parity-signal correction item 4: populates the OPTIONAL `appleReader` section
    via the real Python Apple Books oracle (`python/apple_books_reader.py`'s own
    `load_reader_config`/`read_annotations`) -- never a reimplementation. Only called when the
    caller explicitly opts in (see `--with-apple` below); `annotation_db`/`library_db` are a narrow
    injected seam so tests can point this at a disposable fixture database and NEVER the live one --
    when both are omitted, discovery falls through to the real oracle's own default search (which is
    exactly why this stays off by default)."""
    import apple_books_reader  # noqa: WPS433 -- deliberately deferred: only imported when opted in

    reader_config = apple_books_reader.load_reader_config(
        annotation_db=str(annotation_db) if annotation_db else None,
        library_db=str(library_db) if library_db else None,
    )
    result = apple_books_reader.read_annotations(reader_config)
    apple_reader: Dict = {"status": result["status"], "count": result["count"]}
    annotation_ids = sorted(entry["annotation_id"] for entry in result.get("annotations", []))
    if annotation_ids:
        # Matches shadowEngine.ts's own `digestText(sortedIds.join(","))` exactly -- sha256 of the
        # sorted, comma-joined annotation ids, never the ids themselves.
        apple_reader["annotationIdDigest"] = digest_text(",".join(annotation_ids))
    return apple_reader


def generate_baseline(vault_root: Path, config: Dict, apple_reader: Optional[Dict] = None) -> Dict:
    entries = build_entries(vault_root, config)
    baseline = {
        "schemaVersion": BASELINE_SCHEMA_VERSION,
        "generatedAtIso": canonical_generated_at_iso(),
        "sampleCount": len(entries),
        "entries": entries,
    }
    if apple_reader is not None:
        baseline["appleReader"] = apple_reader
    return baseline


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--vault-root", required=True, type=Path, help="Path to a real vault directory (read-only; never mutated).")
    parser.add_argument("--config", required=True, type=Path, help="Path to the plugin's config.json (the same one the dev TS command reads min_note_words/chunk_*_tokens from).")
    parser.add_argument("--output", required=True, type=Path, help="Where to write the ShadowBaselineV1 JSON file -- point this at <pluginDir>/data/mindmap-engine/shadow-baseline.json.")
    parser.add_argument("--with-apple", action="store_true", help="OFF BY DEFAULT. Also populate the optional appleReader section via the real Python Apple Books oracle (apple_books_reader.py). May touch a live Apple Books database on this machine's default search paths unless --apple-annotation-db/--apple-library-db point at a disposable fixture instead.")
    parser.add_argument("--apple-annotation-db", type=Path, default=None, help="Only used with --with-apple. Overrides the annotation database path (point this at a disposable fixture in tests -- never the live Apple Books DB).")
    parser.add_argument("--apple-library-db", type=Path, default=None, help="Only used with --with-apple. Overrides the library database path (same disposable-fixture-only guidance as --apple-annotation-db).")
    args = parser.parse_args(argv)

    vault_root = args.vault_root.resolve()
    if not vault_root.is_dir():
        print(f"error: --vault-root {vault_root} is not a directory", file=sys.stderr)
        return 1
    if not args.config.is_file():
        print(f"error: --config {args.config} is not a file", file=sys.stderr)
        return 1

    config = json.loads(args.config.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        print("error: --config must contain a JSON object", file=sys.stderr)
        return 1

    apple_reader = build_apple_reader(args.apple_annotation_db, args.apple_library_db) if args.with_apple else None
    baseline = generate_baseline(vault_root, config, apple_reader=apple_reader)
    write_baseline_atomically(args.output.resolve(), baseline)
    print(f"wrote {args.output.resolve()} ({baseline['sampleCount']} entries)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
