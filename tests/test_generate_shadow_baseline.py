import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "python"))
sys.path.insert(0, str(REPO_ROOT / "tools" / "parity"))

import generate_shadow_baseline as gsb  # noqa: E402
import mindmap  # noqa: E402


def make_fixture_vault(root: Path) -> None:
    notes_dir = root / "Notes"
    notes_dir.mkdir(parents=True)
    (notes_dir / "a.md").write_text("---\n---\n" + ("word " * 60), encoding="utf-8")
    (notes_dir / "short.md").write_text("too short", encoding="utf-8")

    annotations_dir = root / "Books" / "Apple Books" / "Author" / "Book" / "Annotations"
    annotations_dir.mkdir(parents=True)
    (annotations_dir / "note.md").write_text(
        "---\ntype: apple-books-annotation\nannotation_id: abc-123\n---\n" + ("word " * 10),
        encoding="utf-8",
    )
    (annotations_dir / "missing-id.md").write_text(
        "---\ntype: apple-books-annotation\n---\n" + ("word " * 10),
        encoding="utf-8",
    )

    index_dir = root / "Books" / "Apple Books" / "Author" / "Book2"
    index_dir.mkdir(parents=True)
    (index_dir / "Index.md").write_text(
        "<!-- mindmap:apple-books-index:start -->\ncontent\n<!-- mindmap:apple-books-index:end -->",
        encoding="utf-8",
    )


class BuildEntriesTests(unittest.TestCase):
    def test_includes_eligible_ordinary_and_annotation_notes_excludes_short_and_missing_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault_root = Path(tmp)
            make_fixture_vault(vault_root)
            config = {"notes_paths_current": ["Notes"], "min_note_words": 30}
            entries = gsb.build_entries(vault_root, config)

            hashed_ids = {entry["hashedId"] for entry in entries}
            expected_ordinary = hashlib.sha256(b"path:Notes/a.md").hexdigest()
            expected_annotation = hashlib.sha256(b"apple-annotation:abc-123").hexdigest()

            self.assertIn(expected_ordinary, hashed_ids)
            self.assertIn(expected_annotation, hashed_ids)
            self.assertEqual(len(entries), 2, "short.md and the missing-id annotation must both be excluded")
            for entry in entries:
                self.assertTrue(entry["eligible"])
                self.assertIsInstance(entry["chunkCount"], int)
                self.assertEqual(set(entry.keys()), {"hashedId", "eligible", "projectionDigest", "chunkCount", "chunkBoundaryDigest"})

    def test_never_includes_a_generated_reading_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault_root = Path(tmp)
            make_fixture_vault(vault_root)
            config = {"notes_paths_current": ["Notes"], "min_note_words": 30}
            entries = gsb.build_entries(vault_root, config)
            index_hash = hashlib.sha256(b"path:Books/Apple Books/Author/Book2/Index.md").hexdigest()
            self.assertNotIn(index_hash, {entry["hashedId"] for entry in entries})

    def test_sample_count_bounded_at_max_sample_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault_root = Path(tmp)
            notes_dir = vault_root / "Notes"
            notes_dir.mkdir(parents=True)
            for index in range(gsb.MAX_SAMPLE_COUNT + 10):
                (notes_dir / f"n{index:03d}.md").write_text("---\n---\n" + ("word " * 60), encoding="utf-8")
            config = {"notes_paths_current": ["Notes"], "min_note_words": 5}
            baseline = gsb.generate_baseline(vault_root, config)
            self.assertLessEqual(baseline["sampleCount"], gsb.MAX_SAMPLE_COUNT)
            self.assertEqual(len(baseline["entries"]), baseline["sampleCount"])

    def test_never_embeds_note_text_or_raw_paths_in_the_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault_root = Path(tmp)
            make_fixture_vault(vault_root)
            config = {"notes_paths_current": ["Notes"], "min_note_words": 30}
            baseline = gsb.generate_baseline(vault_root, config)
            serialized = json.dumps(baseline)
            self.assertNotIn("Notes/a.md", serialized)
            self.assertNotIn("abc-123", serialized)
            self.assertNotIn(str(vault_root), serialized)


class DigestFormulaTests(unittest.TestCase):
    """Checkpoint 9 parity-signal correction item 1: cross-language fixtures proving the
    generator's digests are genuinely comparable (not merely present)."""

    def test_digest_text_normalizes_crlf_and_cr_before_hashing(self):
        self.assertEqual(gsb.digest_text("a\r\nb"), gsb.digest_text("a\nb"))
        self.assertEqual(gsb.digest_text("a\rb"), gsb.digest_text("a\nb"))

    def test_chunk_boundary_digest_is_sha256_of_the_joined_per_chunk_digests(self):
        chunks = ["one", "two"]
        expected = hashlib.sha256(",".join(hashlib.sha256(c.encode("utf-8")).hexdigest() for c in chunks).encode("utf-8")).hexdigest()
        self.assertEqual(gsb.chunk_content_digest(chunks), expected)

    def test_matching_ordinary_note_produces_a_projection_digest_of_its_own_normalized_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault_root = Path(tmp)
            notes_dir = vault_root / "Notes"
            notes_dir.mkdir(parents=True)
            text = "---\nfoo: bar\n---\n" + ("word " * 60)
            (notes_dir / "a.md").write_text(text, encoding="utf-8")
            config = {"notes_paths_current": ["Notes"], "min_note_words": 30}
            entries = gsb.build_entries(vault_root, config)
            self.assertEqual(len(entries), 1)

            frontmatter, body = mindmap.parse_frontmatter(text)
            body = mindmap.strip_related_section(body, gsb.DEFAULT_RELATED_HEADING)
            self.assertEqual(entries[0]["projectionDigest"], gsb.digest_text(body))
            chunks = mindmap.chunk_text(body, gsb.DEFAULT_CHUNK_TARGET_TOKENS, gsb.DEFAULT_CHUNK_OVERLAP_TOKENS)
            self.assertEqual(entries[0]["chunkBoundaryDigest"], gsb.chunk_content_digest(chunks))
            self.assertEqual(entries[0]["chunkCount"], len(chunks))

    def test_matching_annotation_note_produces_a_projection_digest_of_its_own_normalized_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault_root = Path(tmp)
            make_fixture_vault(vault_root)
            config = {"notes_paths_current": ["Notes"], "min_note_words": 30}
            entries = {entry["hashedId"]: entry for entry in gsb.build_entries(vault_root, config)}
            expected_annotation = hashlib.sha256(b"apple-annotation:abc-123").hexdigest()
            self.assertIn(expected_annotation, entries)

            annotation_path = vault_root / "Books" / "Apple Books" / "Author" / "Book" / "Annotations" / "note.md"
            text = annotation_path.read_text(encoding="utf-8")
            frontmatter, body = mindmap.parse_frontmatter(text)
            body = mindmap.strip_related_section(body, gsb.DEFAULT_RELATED_HEADING)
            self.assertEqual(entries[expected_annotation]["projectionDigest"], gsb.digest_text(body))

    def test_intentional_same_length_content_mismatch_yields_different_digests(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault_root = Path(tmp)
            notes_dir = vault_root / "Notes"
            notes_dir.mkdir(parents=True)
            body_a = "aaaa " * 40
            body_b = "bbbb " * 40
            self.assertEqual(len(body_a), len(body_b), "fixture must be an intentional same-length mismatch")
            (notes_dir / "a.md").write_text("---\n---\n" + body_a, encoding="utf-8")
            (notes_dir / "b.md").write_text("---\n---\n" + body_b, encoding="utf-8")
            config = {"notes_paths_current": ["Notes"], "min_note_words": 30}
            entries = {entry["hashedId"]: entry for entry in gsb.build_entries(vault_root, config)}
            hash_a = hashlib.sha256(b"path:Notes/a.md").hexdigest()
            hash_b = hashlib.sha256(b"path:Notes/b.md").hexdigest()
            self.assertNotEqual(entries[hash_a]["projectionDigest"], entries[hash_b]["projectionDigest"])
            self.assertNotEqual(entries[hash_a]["chunkBoundaryDigest"], entries[hash_b]["chunkBoundaryDigest"])


class CatalogPopulationTests(unittest.TestCase):
    """Checkpoint 9 parity-signal correction item 2: overlapping-root dedup and strict
    Reading-annotation-shape admission regressions."""

    def test_overlapping_configured_paths_do_not_duplicate_the_same_relpath(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault_root = Path(tmp)
            notes_dir = vault_root / "Notes"
            notes_dir.mkdir(parents=True)
            (notes_dir / "a.md").write_text("---\n---\n" + ("word " * 60), encoding="utf-8")
            # "." and "Notes" overlap: both configured scopes reach the SAME file.
            config = {"notes_paths_current": [".", "Notes"], "min_note_words": 30}
            entries = gsb.build_entries(vault_root, config)
            hashed_ids = [entry["hashedId"] for entry in entries]
            self.assertEqual(len(hashed_ids), len(set(hashed_ids)), "overlapping configured roots must not duplicate the same relpath")
            expected = hashlib.sha256(b"path:Notes/a.md").hexdigest()
            self.assertEqual(hashed_ids.count(expected), 1)

    def test_broad_reading_scan_excludes_an_ordinary_non_annotation_shaped_file_outside_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault_root = Path(tmp)
            # An ordinary note living under Books/Apple Books but NOT in the strict
            # <author>/<book>/Annotations/<note>.md shape, and not covered by any configured
            # ordinary scope -- must never be admitted via the always-included Reading scan.
            stray_dir = vault_root / "Books" / "Apple Books" / "Author" / "Book"
            stray_dir.mkdir(parents=True)
            (stray_dir / "notes.md").write_text("---\n---\n" + ("word " * 60), encoding="utf-8")
            config = {"notes_paths_current": ["Notes"], "min_note_words": 30}
            entries = gsb.build_entries(vault_root, config)
            stray_hash = hashlib.sha256(b"path:Books/Apple Books/Author/Book/notes.md").hexdigest()
            self.assertNotIn(stray_hash, {entry["hashedId"] for entry in entries})

    def test_broad_reading_scan_still_includes_a_structurally_valid_annotation_outside_ordinary_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault_root = Path(tmp)
            make_fixture_vault(vault_root)
            # Ordinary scope deliberately does not cover Books/Apple Books at all.
            config = {"notes_paths_current": ["Notes"], "min_note_words": 30}
            entries = gsb.build_entries(vault_root, config)
            expected_annotation = hashlib.sha256(b"apple-annotation:abc-123").hexdigest()
            self.assertIn(expected_annotation, {entry["hashedId"] for entry in entries})


class AppleReaderTests(unittest.TestCase):
    """Checkpoint 9 parity-signal correction item 4: optional, off-by-default live Apple
    baseline, exercised here only through a disposable fake/fixture -- never the live DB."""

    def test_with_apple_off_by_default_produces_no_appleReader_section(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault_root = Path(tmp)
            make_fixture_vault(vault_root)
            baseline = gsb.generate_baseline(vault_root, {"notes_paths_current": ["Notes"], "min_note_words": 30})
            self.assertNotIn("appleReader", baseline)

    def test_build_apple_reader_uses_the_injected_disposable_fixture_never_the_live_reader(self):
        fake_result = {
            "status": "success",
            "count": 2,
            "annotations": [{"annotation_id": "aeannotation:2"}, {"annotation_id": "aeannotation:1"}],
        }
        fake_config = object()
        with mock.patch("apple_books_reader.load_reader_config", return_value=fake_config) as load_mock, \
             mock.patch("apple_books_reader.read_annotations", return_value=fake_result) as read_mock:
            annotation_db = Path("/tmp/disposable-fixture-annotation.sqlite")
            library_db = Path("/tmp/disposable-fixture-library.sqlite")
            apple_reader = gsb.build_apple_reader(annotation_db, library_db)

        load_mock.assert_called_once_with(annotation_db=str(annotation_db), library_db=str(library_db))
        read_mock.assert_called_once_with(fake_config)
        self.assertEqual(apple_reader["status"], "success")
        self.assertEqual(apple_reader["count"], 2)
        expected_digest = gsb.digest_text(",".join(sorted(["aeannotation:2", "aeannotation:1"])))
        self.assertEqual(apple_reader["annotationIdDigest"], expected_digest)

    def test_build_apple_reader_omits_the_digest_when_there_are_no_annotations(self):
        fake_result = {"status": "unavailable", "count": 0, "annotations": []}
        with mock.patch("apple_books_reader.load_reader_config", return_value=object()), \
             mock.patch("apple_books_reader.read_annotations", return_value=fake_result):
            apple_reader = gsb.build_apple_reader(None, None)
        self.assertEqual(apple_reader, {"status": "unavailable", "count": 0})


class GeneratedAtIsoTests(unittest.TestCase):
    def test_canonical_iso_format(self):
        value = gsb.canonical_generated_at_iso()
        # Matches shadowEngine.ts's CANONICAL_ISO_PATTERN exactly.
        self.assertRegex(value, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class AtomicWriteTests(unittest.TestCase):
    def test_write_baseline_atomically_leaves_no_temp_file_and_produces_valid_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "nested" / "shadow-baseline.json"
            baseline = {"schemaVersion": 1, "generatedAtIso": gsb.canonical_generated_at_iso(), "sampleCount": 0, "entries": []}
            gsb.write_baseline_atomically(output_path, baseline)
            self.assertTrue(output_path.is_file())
            loaded = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(loaded, baseline)
            leftover_temp_files = [entry for entry in output_path.parent.iterdir() if entry.name.startswith(".shadow-baseline-")]
            self.assertEqual(leftover_temp_files, [])


class CliIntegrationTests(unittest.TestCase):
    def test_running_the_script_as_a_subprocess_produces_a_file_a_ts_consumer_can_load(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault_root = Path(tmp) / "vault"
            make_fixture_vault(vault_root)
            config_path = Path(tmp) / "config.json"
            config_path.write_text(json.dumps({"notes_paths_current": ["Notes"], "min_note_words": 30}), encoding="utf-8")
            output_path = Path(tmp) / "data" / "mindmap-engine" / "shadow-baseline.json"

            result = subprocess.run(
                [sys.executable, str(REPO_ROOT / "tools" / "parity" / "generate_shadow_baseline.py"),
                 "--vault-root", str(vault_root), "--config", str(config_path), "--output", str(output_path)],
                capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output_path.is_file())
            loaded = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(loaded["schemaVersion"], 1)
            self.assertIsInstance(loaded["entries"], list)
            self.assertGreater(len(loaded["entries"]), 0)


if __name__ == "__main__":
    unittest.main()
