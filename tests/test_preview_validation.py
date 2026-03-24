import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from mindmap import resolve_vault_markdown_write_target, validate_preview_entry  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
