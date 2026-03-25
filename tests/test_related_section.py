import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from mindmap import strip_related_section, update_related_section  # noqa: E402


class RelatedSectionTests(unittest.TestCase):
    def test_update_related_section_omits_graph_shortcut_icon_link(self):
        original = "Body content.\n"
        updated = update_related_section(
            original,
            "## Mindmap",
            [
                ("Notes/Alpha.md", "core"),
                ("Journal/Beta.md", "creative"),
            ],
        )

        self.assertIn("> [!mindmap]- Mindmap", updated)
        self.assertIn("[[Notes/Alpha.md|Alpha]]", updated)
        self.assertIn("[[Journal/Beta.md|Beta]]", updated)
        self.assertNotIn("graph:open-local-graph", updated)
        self.assertNotIn("> [◎]", updated)

    def test_strip_related_section_removes_legacy_callout_block(self):
        original = """Body.\n\n---\n\n> [!mindmap]- Mindmap\n> - [[Notes/Alpha.md|Alpha]]\n> [◎](obsidian://command?name=graph:open-local-graph)\n"""
        stripped = strip_related_section(original, "## Mindmap")

        self.assertIn("Body.", stripped)
        self.assertNotIn("[!mindmap]", stripped)
        self.assertNotIn("graph:open-local-graph", stripped)


if __name__ == "__main__":
    unittest.main()

