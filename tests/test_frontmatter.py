import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from mindmap import parse_frontmatter, update_frontmatter  # noqa: E402


class FrontmatterUpdateTests(unittest.TestCase):
    def test_round_trip_preserves_comments_and_nested_structures(self):
        original = """---
# document comment
title: Sample Note
aliases:
  - Alpha
metadata:
  owner: prashant
  flags:
    pinned: true # inline comment
summary: old summary
---
Body text here.
"""

        updated = update_frontmatter(
            original,
            {
                "summary": "new summary",
                "tags": ["one", "two"],
                "concepts": ["focus"],
                "related": ["Notes/Other.md"],
            },
            ["summary", "tags", "concepts", "related"],
        )

        self.assertIn("# document comment", updated)
        self.assertIn("title: Sample Note", updated)
        self.assertIn("owner: prashant", updated)
        self.assertIn("pinned: true # inline comment", updated)
        self.assertIn("summary: new summary", updated)
        self.assertIn("tags:", updated)
        self.assertIn("  - one", updated)
        self.assertTrue(updated.endswith("Body text here.\n"))

    def test_multiline_scalars_are_preserved_when_untouched(self):
        original = """---
description: |
  line one
  line two
notes:
  - keep
summary: old
---
Body.
"""

        updated = update_frontmatter(
            original,
            {"summary": "fresh"},
            ["summary", "tags", "concepts", "related"],
        )

        self.assertIn("description: |", updated)
        self.assertIn("  line one", updated)
        self.assertIn("  line two", updated)
        self.assertIn("summary: fresh", updated)
        self.assertIn("notes:\n  - keep", updated)

    def test_unknown_fields_stay_intact_when_known_fields_change(self):
        original = """---
created: 2026-03-24
custom:
  nested:
    keep: me
summary: old summary
tags:
  - legacy
---
Body text.
"""

        updated = update_frontmatter(
            original,
            {
                "summary": "updated summary",
                "tags": ["tag-a", "tag-b"],
                "concepts": ["concept-a", "concept-b"],
                "related": ["Vault/Linked.md"],
            },
            ["summary", "tags", "concepts", "related"],
        )

        self.assertIn("created: 2026-03-24", updated)
        self.assertIn("keep: me", updated)
        self.assertIn("summary: updated summary", updated)
        self.assertIn("  - tag-a", updated)
        self.assertIn("  - concept-a", updated)
        self.assertIn("  - Vault/Linked.md", updated)
        self.assertTrue(updated.endswith("Body text.\n"))

    def test_no_frontmatter_case_still_works(self):
        original = "Simple body only.\n"
        updated = update_frontmatter(
            original,
            {
                "summary": "summary text",
                "tags": ["tag-a"],
                "concepts": ["concept-a"],
                "related": ["Path/Note.md"],
            },
            ["summary", "tags", "concepts", "related"],
        )

        parsed, body = parse_frontmatter(updated)
        self.assertEqual(parsed["summary"], "summary text")
        self.assertEqual(parsed["tags"], ["tag-a"])
        self.assertEqual(parsed["concepts"], ["concept-a"])
        self.assertEqual(parsed["related"], ["Path/Note.md"])
        self.assertEqual(body, "Simple body only.\n")


if __name__ == "__main__":
    unittest.main()
