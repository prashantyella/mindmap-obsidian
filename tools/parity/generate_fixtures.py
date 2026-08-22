#!/usr/bin/env python3
"""Development-only fixture generator for the TypeScript rewrite's parity
corpus (tests/fixtures/engine/). Imports python/mindmap.py directly and
records its behavior on synthetic, redacted inputs as deterministic JSON.

Not part of the shipped product: this script is never imported by
python/mindmap.py, python/mindmap_worker.py, or anything reachable from
main.ts/the esbuild bundle. It is run by hand during development only, and
never touches a real vault (every input below is hand-authored).

Usage: python3 tools/parity/generate_fixtures.py
"""

import hashlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "python"))

import mindmap  # noqa: E402

FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures" / "engine"
PYTHON_ORACLE_FILE = "python/mindmap.py"
FIXTURE_SCHEMA_VERSION = 1


def python_oracle_sha256() -> str:
    return hashlib.sha256((REPO_ROOT / PYTHON_ORACLE_FILE).read_bytes()).hexdigest()


def write_fixture(name: str, payload) -> None:
    # Every fixture records which exact python/mindmap.py it was captured
    # against (by content hash, not just a version number) so a TS-side
    # test can catch a stale fixture the moment the oracle file changes,
    # without ever executing Python at test time.
    provenance = {
        "fixtureSchemaVersion": FIXTURE_SCHEMA_VERSION,
        "pythonOracleFile": PYTHON_ORACLE_FILE,
        "pythonOracleSha256": python_oracle_sha256(),
        "generator": "tools/parity/generate_fixtures.py",
    }
    full_payload = {"provenance": provenance, **payload}
    path = FIXTURES_DIR / name
    path.write_text(json.dumps(full_payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(REPO_ROOT)}")


def frontmatter_fixture():
    cases = []

    text_a = "---\ntitle: Example\nsummary: old\ntags:\n  - alpha\nauthor: Jane\n---\nBody.\n"
    updated_a = mindmap.update_frontmatter(
        text_a,
        {"summary": "new summary", "tags": ["beta", "gamma"], "concepts": ["one"], "related": ["Notes/Other.md"]},
        preferred_order=["summary", "tags", "concepts", "related"],
    )
    cases.append({
        "name": "update_frontmatter preserves unrelated fields and updates managed keys",
        "input": text_a,
        "updates": {"summary": "new summary", "tags": ["beta", "gamma"], "concepts": ["one"], "related": ["Notes/Other.md"]},
        "preferred_order": ["summary", "tags", "concepts", "related"],
        "output": updated_a,
    })

    text_b = "---\ntitle: Annotation\ntype: apple-books-annotation\nsummary: old\ntags:\n  - alpha\n---\nQuote body.\n"
    updated_b = mindmap.update_frontmatter(
        text_b,
        {"concepts": ["[[One]]"], "related": ["[[Notes/Other|Other]]"]},
        preferred_order=["summary", "tags", "concepts", "related"],
        remove_keys=mindmap.APPLE_ANNOTATION_CLEARED_KEYS,
    )
    cases.append({
        "name": "update_frontmatter clears summary/tags for Apple annotation notes",
        "input": text_b,
        "updates": {"concepts": ["[[One]]"], "related": ["[[Notes/Other|Other]]"]},
        "preferred_order": ["summary", "tags", "concepts", "related"],
        "remove_keys": mindmap.APPLE_ANNOTATION_CLEARED_KEYS,
        "output": updated_b,
    })

    fm, body = mindmap.parse_frontmatter("---\ntitle: Example\ntags:\n  - a\n  - b\n---\nBody text.\n")
    cases.append({
        "name": "parse_frontmatter returns plain dict and body",
        "input": "---\ntitle: Example\ntags:\n  - a\n  - b\n---\nBody text.\n",
        "frontmatter": fm,
        "body": body,
    })

    write_fixture("frontmatter.json", {"cases": cases})


def related_section_fixture():
    cases = []
    heading = "## Mindmap"

    before = "Body content.\n\n## Mindmap\n- [[Notes/Old]]\n"
    stripped = mindmap.strip_related_section(before, heading)
    cases.append({
        "name": "strip_related_section removes legacy heading block",
        "input": before,
        "heading": heading,
        "output": stripped,
        "contains_managed": mindmap.contains_managed_related_content(before, heading),
    })

    with_callout = 'Body content.\n\n---\n\n> [!mindmap]- Mindmap\n> - <span class="mindmap-link is-core">[[Notes/A|A]]</span>\n'
    cases.append({
        "name": "strip_related_section removes callout block",
        "input": with_callout,
        "heading": heading,
        "output": mindmap.strip_related_section(with_callout, heading),
        "contains_managed": mindmap.contains_managed_related_content(with_callout, heading),
    })

    updated = mindmap.update_related_section(
        "Body content.\n",
        heading,
        [("Notes/A.md", "core"), ("Notes/B.md", "overreach")],
    )
    cases.append({
        "name": "update_related_section renders a fresh callout block",
        "input": "Body content.\n",
        "heading": heading,
        "links": [["Notes/A.md", "core"], ["Notes/B.md", "overreach"]],
        "output": updated,
    })

    write_fixture("related_section.json", {"cases": cases})


def chunking_fixture():
    cases = []
    samples = [
        ("short text under target size", "one two three four five", 400, 40),
        ("long text requiring multiple chunks", " ".join(f"word{i}" for i in range(1, 601)), 400, 40),
        ("empty text", "", 400, 40),
    ]
    for name, text, target_tokens, overlap_tokens in samples:
        chunks = mindmap.chunk_text(text, target_tokens, overlap_tokens)
        cases.append({
            "name": name,
            "text": text,
            "target_tokens": target_tokens,
            "overlap_tokens": overlap_tokens,
            "chunks": chunks,
        })
    write_fixture("chunking.json", {"cases": cases})


def normalization_fixture():
    cases = []
    cases.append({
        "name": "normalize_tags lowercases, slugifies, and dedupes",
        "input": ["Machine Learning", "machine-learning", "  Spaced Tag  ", "Weird!!Chars", ""],
        "output": mindmap.normalize_tags(["Machine Learning", "machine-learning", "  Spaced Tag  ", "Weird!!Chars", ""]),
    })
    concepts_input = ["Neural Networks", "neural networks", "A Very Long Concept Phrase That Exceeds The Word Limit", "Short"]
    cases.append({
        "name": "normalize_concepts bounds length/words and dedupes case-insensitively",
        "input": concepts_input,
        "limit": 3,
        "max_words": 4,
        "case_mode": "title",
        "output": mindmap.normalize_concepts(concepts_input, limit=3, max_words=4, case_mode="title"),
    })
    tags_input = ["machinelearning", "ml", "unrelatedtag"]
    controlled = ["machine-learning", "artificial-intelligence"]
    cases.append({
        "name": "filter_and_map_tags maps close matches to controlled vocabulary",
        "input": tags_input,
        "controlled": controlled,
        "allow_free": False,
        "min_len": 2,
        "max_words": 3,
        "output": mindmap.filter_and_map_tags(tags_input, controlled, allow_free=False, min_len=2, max_words=3),
    })
    write_fixture("normalization.json", {"cases": cases})


def related_selection_fixture():
    cases = []
    candidates = [
        ["Notes/A.md", 0.95],
        ["Notes/B.md", 0.90],
        ["Journal/C.md", 0.88],
        ["Notes/D.md", 0.60],
        ["Notes/E.md", 0.50],
        ["Journal/F.md", 0.30],
    ]
    picked = mindmap.select_mindmap_links(
        [(c[0], c[1]) for c in candidates],
        self_path="Notes/Self.md",
        related_limit=4,
        overreach_count=1,
        creative_count=1,
        creative_min=0.45,
        creative_max=0.65,
    )
    cases.append({
        "name": "select_mindmap_links applies core/overreach/creative/fill tie-breaking",
        "candidates": candidates,
        "self_path": "Notes/Self.md",
        "related_limit": 4,
        "overreach_count": 1,
        "creative_count": 1,
        "creative_min": 0.45,
        "creative_max": 0.65,
        "output": picked,
    })

    tie_candidates = [["Notes/X.md", 0.5], ["Notes/Y.md", 0.5], ["Notes/Self.md", 0.99]]
    tie_picked = mindmap.select_mindmap_links(
        [(c[0], c[1]) for c in tie_candidates],
        self_path="Notes/Self.md",
        related_limit=2,
        overreach_count=0,
        creative_count=0,
        creative_min=0.45,
        creative_max=0.65,
    )
    cases.append({
        "name": "select_mindmap_links excludes self and preserves input order on score ties",
        "candidates": tie_candidates,
        "self_path": "Notes/Self.md",
        "related_limit": 2,
        "overreach_count": 0,
        "creative_count": 0,
        "creative_min": 0.45,
        "creative_max": 0.65,
        "output": tie_picked,
    })
    write_fixture("related_selection.json", {"cases": cases})


def eligibility_fixture():
    cases = []
    ordinary_body = "word " * 60
    fm_ordinary = {"type": "note"}
    cases.append({
        "name": "ordinary note meets configured minimum word count",
        "text": ordinary_body,
        "frontmatter": fm_ordinary,
        "configured_minimum": 50,
        "meets_minimum": mindmap.note_meets_minimum(ordinary_body, fm_ordinary, 50),
    })
    cases.append({
        "name": "ordinary note below configured minimum word count is ineligible",
        "text": "too short",
        "frontmatter": fm_ordinary,
        "configured_minimum": 50,
        "meets_minimum": mindmap.note_meets_minimum("too short", fm_ordinary, 50),
    })
    annotation_body = "one two three four five six seven eight nine"
    fm_annotation = {"type": "apple-books-annotation"}
    cases.append({
        "name": "Apple annotation note uses the fixed 8-word minimum regardless of configured minimum",
        "text": annotation_body,
        "frontmatter": fm_annotation,
        "configured_minimum": 200,
        "minimum_words_for_note": mindmap.minimum_words_for_note(fm_annotation, 200),
        "meets_minimum": mindmap.note_meets_minimum(annotation_body, fm_annotation, 200),
    })
    write_fixture("individual_note_eligibility.json", {"cases": cases})


def apple_annotation_wikilinks_fixture():
    cases = []
    cases.append({
        "name": "apple_annotation_concept_wikilinks sanitizes and dedupes",
        "input": ["Valid Concept", "Valid Concept", "  ", "Bad/Slash\\Chars"],
        "output": mindmap.apple_annotation_concept_wikilinks(["Valid Concept", "Valid Concept", "  ", "Bad/Slash\\Chars"]),
    })
    related_input = ["Notes/Valid.md", "../Traversal.md", "Notes/Valid.md", "not-markdown.txt"]
    cases.append({
        "name": "apple_annotation_related_wikilinks rejects unsafe targets and dedupes",
        "input": related_input,
        "output": mindmap.apple_annotation_related_wikilinks(related_input),
    })
    write_fixture("apple_annotation_wikilinks.json", {"cases": cases})


def preview_validation_fixture():
    import tempfile

    cases = []
    with tempfile.TemporaryDirectory() as tmp:
        vault_root = Path(tmp)
        (vault_root / "Notes").mkdir()
        (vault_root / "Notes" / "Existing.md").write_text("Body.\n", encoding="utf-8")

        entries = [
            {"path": "Notes/Existing.md"},
            {"path": ""},
            {"path": ".obsidian/plugins/mindmap-ai/internal.md"},
            {"path": "Notes/NotMarkdown.txt"},
            "not-an-object",
        ]
        for index, entry in enumerate(entries):
            _target, issue = mindmap.validate_preview_entry(entry, vault_root, index)
            cases.append({
                "name": f"validate_preview_entry case {index}",
                "entry": entry,
                "entry_index": index,
                "issue": issue,
            })
    write_fixture("preview_validation.json", {"cases": cases})


def diagnostics_fixture():
    cases = []
    cases.append({
        "name": "build_runtime_issue with guidance and context",
        "level": "error",
        "code": "NOTE_TARGET_MISSING",
        "message": "Individual note not found: Notes/Missing.md",
        "guidance": "Use one existing vault-relative Markdown path.",
        "context": {"path": "Notes/Missing.md"},
        "output": mindmap.build_runtime_issue(
            "error",
            "NOTE_TARGET_MISSING",
            "Individual note not found: Notes/Missing.md",
            guidance="Use one existing vault-relative Markdown path.",
            context={"path": "Notes/Missing.md"},
        ),
    })
    cases.append({
        "name": "build_runtime_issue without guidance/context",
        "level": "warn",
        "code": "PREVIEW_ENTRY_INVALID",
        "message": "Skipping preview entry because it is not a JSON object.",
        "output": mindmap.build_runtime_issue("warn", "PREVIEW_ENTRY_INVALID", "Skipping preview entry because it is not a JSON object."),
    })
    write_fixture("diagnostics.json", {"cases": cases})


def main() -> None:
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    frontmatter_fixture()
    related_section_fixture()
    chunking_fixture()
    normalization_fixture()
    related_selection_fixture()
    eligibility_fixture()
    apple_annotation_wikilinks_fixture()
    preview_validation_fixture()
    diagnostics_fixture()


if __name__ == "__main__":
    main()
