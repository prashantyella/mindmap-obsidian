import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from mindmap import (  # noqa: E402
    finalize_run_state,
    list_notes,
    load_note_by_relpath,
    main,
    validate_individual_note_target,
)


class IndividualNoteTests(unittest.TestCase):
    def test_cli_rejects_note_with_scope_or_global_flags_during_parse(self):
        invalid_args = (
            ("--note", "Notes/one.md", "--current"),
            ("--note", "Notes/one.md", "--all"),
            ("--note", "Notes/one.md", "--refresh-all"),
            ("--note", "Notes/one.md", "--rebuild"),
            ("--note", "Notes/one.md", "--apply-preview"),
            ("--note", "Notes/one.md", "--limit", "1"),
        )

        for args in invalid_args:
            with self.subTest(args=args), patch.object(sys, "argv", ["mindmap.py", *args]):
                stderr = io.StringIO()
                with self.assertRaises(SystemExit) as error, contextlib.redirect_stderr(stderr):
                    main()
                self.assertEqual(error.exception.code, 2)
                self.assertIn("not allowed with argument", stderr.getvalue())

    def test_target_path_security_and_scope(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vault = Path(tmpdir) / "vault"
            (vault / "Notes").mkdir(parents=True)
            (vault / "Notes" / "valid.md").write_text("one two three", encoding="utf-8")
            (vault / ".obsidian" / "plugins").mkdir(parents=True)
            (vault / ".obsidian" / "plugins" / "runtime.md").write_text("internal", encoding="utf-8")

            for candidate, expected in (
                (str((vault / "Notes" / "valid.md").resolve()), "NOTE_TARGET_ABSOLUTE"),
                ("../outside.md", "NOTE_TARGET_TRAVERSAL"),
                ("Notes/valid.txt", "NOTE_TARGET_NOT_MARKDOWN"),
                (".obsidian/plugins/runtime.md", "NOTE_TARGET_RUNTIME_INTERNAL"),
                ("Other/valid.md", "NOTE_TARGET_OUT_OF_SCOPE"),
            ):
                _target, issue = validate_individual_note_target(vault, candidate, ["Notes"])
                self.assertIsNotNone(issue)
                self.assertEqual(issue["code"], expected)

    def test_missing_target_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vault = Path(tmpdir) / "vault"
            (vault / "Notes").mkdir(parents=True)
            _target, issue = validate_individual_note_target(vault, "Notes/missing.md", ["Notes"])

        self.assertIsNotNone(issue)
        self.assertEqual(issue["code"], "NOTE_TARGET_MISSING")

    def test_reading_annotation_target_is_allowed_without_expanding_all_scope(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vault = Path(tmpdir) / "vault"
            reading = vault / "Books" / "Apple Books" / "Book" / "Annotations"
            reading.mkdir(parents=True)
            annotation = reading / "annotation.md"
            annotation.write_text("---\ntype: apple-books-annotation\n---\none two three four five six seven eight", encoding="utf-8")
            wrong_type = reading / "wrong.md"
            wrong_type.write_text("---\ntype: note\n---\nordinary", encoding="utf-8")
            spoof = vault / "Books" / "Apple Books Spoof" / "spoof.md"
            spoof.parent.mkdir(parents=True)
            spoof.write_text("---\ntype: apple-books-annotation\n---\nspoof", encoding="utf-8")

            target, issue = validate_individual_note_target(vault, "Books/Apple Books/Book/Annotations/annotation.md", ["Notes"])
            _wrong, wrong_issue = validate_individual_note_target(vault, "Books/Apple Books/Book/Annotations/wrong.md", ["Notes"])
            _spoof, spoof_issue = validate_individual_note_target(vault, "Books/Apple Books Spoof/spoof.md", ["Notes"])
            all_scope = list_notes(vault, ["Notes"], 1, "## Mindmap")

        self.assertEqual(target, annotation.resolve())
        self.assertIsNone(issue)
        self.assertEqual(wrong_issue["code"], "NOTE_TARGET_OUT_OF_SCOPE")
        self.assertEqual(spoof_issue["code"], "NOTE_TARGET_OUT_OF_SCOPE")
        self.assertEqual(all_scope, [])

    def test_annotation_threshold_is_eight_and_ordinary_threshold_is_unchanged(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vault = Path(tmpdir) / "vault"
            (vault / "Notes").mkdir(parents=True)
            (vault / "Notes" / "annotation.md").write_text(
                "---\ntype: apple-books-annotation\n---\nquote one two three four five six seven eight",
                encoding="utf-8",
            )
            (vault / "Notes" / "short-annotation.md").write_text(
                "---\ntype: apple-books-annotation\n---\nquote one two three",
                encoding="utf-8",
            )
            (vault / "Notes" / "ordinary.md").write_text("one two three four five", encoding="utf-8")

            notes = list_notes(vault, ["Notes"], 6, "## Mindmap")
            self.assertEqual({note.relpath for note in notes}, {"Notes/annotation.md"})
            with self.assertRaisesRegex(RuntimeError, "NOTE_TOO_SHORT"):
                load_note_by_relpath(vault, "Notes/short-annotation.md", "## Mindmap", min_words=6)

    def test_all_scope_universe_is_separate_from_single_target_selection(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vault = Path(tmpdir) / "vault"
            for folder in ("Notes", "Archive"):
                (vault / folder).mkdir(parents=True)
            (vault / "Notes" / "target.md").write_text("target " * 10, encoding="utf-8")
            (vault / "Archive" / "candidate.md").write_text("candidate " * 10, encoding="utf-8")

            target, issue = validate_individual_note_target(vault, "Notes/target.md", ["Notes", "Archive"])
            universe = list_notes(vault, ["Notes", "Archive"], 3, "## Mindmap")

        self.assertIsNone(issue)
        self.assertEqual(target, (vault / "Notes" / "target.md").resolve())
        self.assertEqual({note.relpath for note in universe}, {"Notes/target.md", "Archive/candidate.md"})

    def test_state_preserves_unrelated_entries_and_removes_failed_target(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            vault = Path(tmpdir) / "vault"
            target = vault / "Notes" / "target.md"
            target.parent.mkdir(parents=True)
            target.write_text("target", encoding="utf-8")
            state = {"version": 1, "reading": {"lastSyncAt": "later"}}
            state_files = {"Notes/target.md": {"hash": "old"}, "Notes/other.md": {"hash": "keep"}}

            result = finalize_run_state(state, state_files, {"Notes/target.md"}, target, vault, True)

        self.assertEqual(result["version"], 1)
        self.assertEqual(result["reading"]["lastSyncAt"], "later")
        self.assertNotIn("Notes/target.md", result["files"])
        self.assertIn("Notes/other.md", result["files"])


if __name__ == "__main__":
    unittest.main()
