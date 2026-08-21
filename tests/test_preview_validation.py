import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from mindmap import main, resolve_vault_markdown_write_target, split_frontmatter, validate_preview_entry  # noqa: E402


class PreviewValidationTests(unittest.TestCase):
    def test_resolve_write_target_accepts_valid_in_vault_markdown_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vault = Path(tmpdir) / "vault"
            note_path = vault / "Notes" / "valid.md"
            note_path.parent.mkdir(parents=True)
            note_path.write_text("# valid\n", encoding="utf-8")

            target, issue = resolve_vault_markdown_write_target(vault, "Notes/valid.md")

        self.assertIsNone(issue)
        self.assertEqual(target, note_path.resolve())

    def test_resolve_write_target_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vault = Path(tmpdir) / "vault"
            vault.mkdir()

            target, issue = resolve_vault_markdown_write_target(vault, "../outside.md")

        self.assertIsNone(target)
        self.assertIsNotNone(issue)
        self.assertEqual(issue["code"], "WRITE_TARGET_TRAVERSAL")

    def test_resolve_write_target_rejects_absolute_path_outside_vault(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            vault = root / "vault"
            vault.mkdir()
            outside = root / "outside.md"
            outside.write_text("# outside\n", encoding="utf-8")

            target, issue = resolve_vault_markdown_write_target(vault, str(outside.resolve()))

        self.assertIsNone(target)
        self.assertIsNotNone(issue)
        self.assertEqual(issue["code"], "WRITE_TARGET_OUTSIDE_VAULT")

    def test_validate_preview_entry_handles_missing_file_without_exception(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vault = Path(tmpdir) / "vault"
            (vault / "Notes").mkdir(parents=True)

            target, issue = validate_preview_entry({"path": "Notes/missing.md"}, vault, entry_index=7)

        self.assertIsNone(target)
        self.assertIsNotNone(issue)
        self.assertEqual(issue["code"], "PREVIEW_TARGET_MISSING")
        self.assertEqual(issue["level"], "warn")

    def test_validate_preview_entry_rejects_plugin_internal_target(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vault = Path(tmpdir) / "vault"
            internal = vault / ".obsidian" / "plugins" / "mindmap-ai" / "data" / "note.md"
            internal.parent.mkdir(parents=True)
            internal.write_text("stub", encoding="utf-8")

            target, issue = validate_preview_entry(
                {"path": ".obsidian/plugins/mindmap-ai/data/note.md"}, vault, entry_index=1,
            )

        self.assertIsNone(target)
        self.assertEqual(issue["code"], "PREVIEW_TARGET_RUNTIME_INTERNAL")

    def test_validate_preview_entry_rejects_non_string_summary(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vault = Path(tmpdir) / "vault"
            note = vault / "Notes" / "one.md"
            note.parent.mkdir(parents=True)
            note.write_text("stub", encoding="utf-8")

            target, issue = validate_preview_entry({"path": "Notes/one.md", "summary": 42}, vault, entry_index=1)

        self.assertIsNone(target)
        self.assertEqual(issue["code"], "PREVIEW_METADATA_INVALID")

    def test_validate_preview_entry_rejects_non_list_or_non_string_items(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vault = Path(tmpdir) / "vault"
            note = vault / "Notes" / "one.md"
            note.parent.mkdir(parents=True)
            note.write_text("stub", encoding="utf-8")

            for field, value in (
                ("tags", "not-a-list"),
                ("concepts", {"a": 1}),
                ("related", [1, 2]),
                ("tags", [None]),
            ):
                with self.subTest(field=field, value=value):
                    target, issue = validate_preview_entry({"path": "Notes/one.md", field: value}, vault, entry_index=1)
                    self.assertIsNone(target)
                    self.assertEqual(issue["code"], "PREVIEW_METADATA_INVALID")

    def test_validate_preview_entry_accepts_well_formed_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vault = Path(tmpdir) / "vault"
            note = vault / "Notes" / "one.md"
            note.parent.mkdir(parents=True)
            note.write_text("stub", encoding="utf-8")

            target, issue = validate_preview_entry(
                {"path": "Notes/one.md", "summary": "s", "tags": ["a"], "concepts": ["b"], "related": ["Notes/c.md"]},
                vault,
                entry_index=1,
            )

        self.assertIsNotNone(target)
        self.assertIsNone(issue)


def write_test_config(tmpdir: str, **overrides) -> Path:
    config = json.loads((Path(__file__).resolve().parents[1] / "python" / "config.template.json").read_text(encoding="utf-8"))
    config.update({"vault_root": str(Path(tmpdir) / "vault"), "preview_log_path": "preview.jsonl"}, **overrides)
    config_path = Path(tmpdir) / "config.json"
    config_path.write_text(json.dumps(config), encoding="utf-8")
    return config_path


class ApplyPreviewAnnotationSafetyTests(unittest.TestCase):
    """--apply-preview must route a stale Apple Books annotation preview
    entry through the same annotation-safe write rules as the live daily
    path, while an ordinary note in the same preview.jsonl keeps the
    unchanged plain behavior."""

    def _run_apply_preview(self, tmpdir: str, config_path: Path) -> int:
        with patch.object(sys, "argv", ["mindmap.py", "--config", str(config_path), "--apply-preview"]):
            return main()

    def test_apply_preview_is_annotation_safe_for_annotation_notes_and_unchanged_for_ordinary_notes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vault = Path(tmpdir) / "vault"
            (vault / "Books" / "Apple Books" / "Author" / "Book" / "Annotations").mkdir(parents=True)
            (vault / "Notes").mkdir(parents=True)

            annotation_note = vault / "Books" / "Apple Books" / "Author" / "Book" / "Annotations" / "Quote.md"
            annotation_note.write_text(
                "---\n"
                "type: apple-books-annotation\n"
                "annotation_id: abc123\n"
                "summary: stale generated summary\n"
                "tags:\n"
                "  - stale-tag\n"
                'research: "[[Books/Apple Books/Author/Book/Research/Quote|Research]]"\n'
                "---\n"
                "> A quote worth keeping.\n"
                "\n---\n\n"
                "> [!mindmap]- Mindmap\n"
                "> - <span class=\"mindmap-link is-core\">[[Notes/old|old]]</span>\n",
                encoding="utf-8",
            )

            ordinary_note = vault / "Notes" / "Ordinary.md"
            ordinary_note.write_text("---\ncustom_field: keep-me\n---\nOrdinary note body.\n", encoding="utf-8")

            preview_lines = [
                json.dumps({
                    "path": "Books/Apple Books/Author/Book/Annotations/Quote.md",
                    "summary": "fresh summary that must not be written",
                    "tags": ["fresh-tag"],
                    "concepts": ["Habit formation"],
                    "related": ["Books/Apple Books/Author/Book/Annotations/Other.md"],
                }),
                json.dumps({
                    "path": "Notes/Ordinary.md",
                    "summary": "Ordinary summary",
                    "tags": ["ordinary-tag"],
                    "concepts": ["Ordinary Concept"],
                    "related": ["Notes/Sibling.md"],
                }),
            ]
            preview_path = vault / "preview.jsonl"
            preview_path.write_text("\n".join(preview_lines) + "\n", encoding="utf-8")

            config_path = write_test_config(tmpdir, write_mindmap_section=True)

            exit_code = self._run_apply_preview(tmpdir, config_path)
            self.assertEqual(exit_code, 0)

            annotation_final = annotation_note.read_text(encoding="utf-8")
            annotation_fm, annotation_body = split_frontmatter(annotation_final)
            self.assertNotIn("summary", annotation_fm)
            self.assertNotIn("tags", annotation_fm)
            self.assertNotIn("stale generated summary", annotation_final)
            self.assertNotIn("fresh summary that must not be written", annotation_final)
            self.assertIn("annotation_id: abc123", annotation_fm)
            self.assertIn("[[Books/Apple Books/Author/Book/Research/Quote|Research]]", annotation_fm)
            self.assertIn("[[Habit formation]]", annotation_fm)
            self.assertIn("[[Books/Apple Books/Author/Book/Annotations/Other|Other]]", annotation_fm)
            self.assertNotIn("[!mindmap]", annotation_final)
            self.assertNotIn("Notes/old", annotation_final)
            self.assertEqual(annotation_body.strip(), "> A quote worth keeping.")

            ordinary_final = ordinary_note.read_text(encoding="utf-8")
            ordinary_fm, _ordinary_body = split_frontmatter(ordinary_final)
            self.assertIn("summary: Ordinary summary", ordinary_final)
            self.assertIn("ordinary-tag", ordinary_final)
            self.assertIn("Ordinary Concept", ordinary_final)
            self.assertIn("custom_field: keep-me", ordinary_fm)
            self.assertIn("[!mindmap]- Mindmap", ordinary_final)
            self.assertIn("[[Notes/Sibling.md|Sibling]]", ordinary_final)


if __name__ == "__main__":
    unittest.main()
