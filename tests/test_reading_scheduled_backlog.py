import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from mindmap import (  # noqa: E402
    Note,
    READING_INDEX_END,
    READING_INDEX_START,
    READING_NOTES_ROOT,
    apple_annotation_concept_wikilink,
    apple_annotation_concept_wikilinks,
    apple_annotation_related_wikilink,
    apple_annotation_related_wikilinks,
    apply_note_frontmatter_write,
    build_metadata_updates,
    compute_removed_paths,
    is_generated_reading_index,
    is_reading_annotation_relpath,
    is_reading_index_relpath,
    main,
    reading_paths_excluded_from_rebuild_scan,
    rebuild_collections_preserving_reading,
    split_frontmatter,
)


def write_config(tmpdir: str, **overrides) -> Path:
    config = json.loads((Path(__file__).resolve().parents[1] / "python" / "config.template.json").read_text(encoding="utf-8"))
    config.update({"vault_root": str(Path(tmpdir) / "vault")}, **overrides)
    config_path = Path(tmpdir) / "config.json"
    config_path.write_text(json.dumps(config), encoding="utf-8")
    (Path(tmpdir) / "vault").mkdir(parents=True, exist_ok=True)
    return config_path


class IncludeReadingPendingArgParsingTests(unittest.TestCase):
    def test_rejected_without_all(self):
        with patch.object(sys, "argv", ["mindmap.py", "--apply", "--include-reading-pending"]):
            stderr = io.StringIO()
            with self.assertRaises(SystemExit) as error, contextlib.redirect_stderr(stderr):
                main()
            self.assertEqual(error.exception.code, 2)
            self.assertIn("requires --all", stderr.getvalue())

    def test_rejected_without_apply(self):
        with patch.object(sys, "argv", ["mindmap.py", "--all", "--include-reading-pending"]):
            stderr = io.StringIO()
            with self.assertRaises(SystemExit) as error, contextlib.redirect_stderr(stderr):
                main()
            self.assertEqual(error.exception.code, 2)
            self.assertIn("requires --apply", stderr.getvalue())

    def test_rejected_with_incompatible_flags(self):
        invalid_suffixes = (
            ("--current",),
            ("--refresh-all",),
            ("--rebuild",),
            ("--preview",),
            ("--apply-preview",),
        )
        for suffix in invalid_suffixes:
            args = ["mindmap.py", "--all", "--apply", "--include-reading-pending", *suffix]
            with self.subTest(args=args), patch.object(sys, "argv", args):
                stderr = io.StringIO()
                with self.assertRaises(SystemExit) as error, contextlib.redirect_stderr(stderr):
                    main()
                self.assertEqual(error.exception.code, 2)
                self.assertIn("not allowed with argument", stderr.getvalue())

    def test_rejected_with_note(self):
        with patch.object(sys, "argv", ["mindmap.py", "--note", "Notes/a.md", "--include-reading-pending"]):
            stderr = io.StringIO()
            with self.assertRaises(SystemExit) as error, contextlib.redirect_stderr(stderr):
                main()
            self.assertEqual(error.exception.code, 2)


class IncludeReadingPendingScopeExtensionTests(unittest.TestCase):
    def test_all_apply_with_flag_extends_note_universe_with_reading_root(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = write_config(tmpdir, notes_paths_all=["Notes"])
            calls = []

            def counted_list_notes(_root, paths, *_args, **_kwargs):
                calls.append(paths)
                return []

            with patch("mindmap.list_notes", side_effect=counted_list_notes), \
                    patch.object(sys, "argv", ["mindmap.py", "--config", str(config_path), "--all", "--apply", "--include-reading-pending"]):
                self.assertEqual(main(), 0)

        self.assertEqual(calls, [["Notes", READING_NOTES_ROOT]])

    def test_all_apply_without_flag_does_not_extend_note_universe(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = write_config(tmpdir, notes_paths_all=["Notes"])
            calls = []

            def counted_list_notes(_root, paths, *_args, **_kwargs):
                calls.append(paths)
                return []

            with patch("mindmap.list_notes", side_effect=counted_list_notes), \
                    patch.object(sys, "argv", ["mindmap.py", "--config", str(config_path), "--all", "--apply"]):
                self.assertEqual(main(), 0)

        self.assertEqual(calls, [["Notes"]])

    def test_flag_does_not_duplicate_scan_when_reading_root_already_in_scope(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = write_config(tmpdir, notes_paths_all=["."])
            calls = []

            def counted_list_notes(_root, paths, *_args, **_kwargs):
                calls.append(paths)
                return []

            with patch("mindmap.list_notes", side_effect=counted_list_notes), \
                    patch.object(sys, "argv", ["mindmap.py", "--config", str(config_path), "--all", "--apply", "--include-reading-pending"]):
                self.assertEqual(main(), 0)

        self.assertEqual(calls, [["."]])

    def test_flag_controls_whether_list_notes_includes_reading_annotations(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = write_config(tmpdir, notes_paths_all=["Notes"])
            include_flags = []

            def capturing_list_notes(_root, _paths, *_args, include_reading_annotations=False, **_kwargs):
                include_flags.append(include_reading_annotations)
                return []

            with patch("mindmap.list_notes", side_effect=capturing_list_notes), \
                    patch.object(sys, "argv", ["mindmap.py", "--config", str(config_path), "--all", "--apply", "--include-reading-pending"]):
                self.assertEqual(main(), 0)
            self.assertEqual(include_flags, [True])

            include_flags.clear()
            with patch("mindmap.list_notes", side_effect=capturing_list_notes), \
                    patch.object(sys, "argv", ["mindmap.py", "--config", str(config_path), "--all", "--apply"]):
                self.assertEqual(main(), 0)
            self.assertEqual(include_flags, [False])

    def test_flag_never_rewrites_config_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = write_config(tmpdir, notes_paths_all=["Notes"])
            original_bytes = config_path.read_bytes()

            with patch("mindmap.list_notes", return_value=[]), \
                    patch.object(sys, "argv", ["mindmap.py", "--config", str(config_path), "--all", "--apply", "--include-reading-pending"]):
                main()

            self.assertEqual(config_path.read_bytes(), original_bytes)


class ComputeRemovedPathsTests(unittest.TestCase):
    def test_runs_without_reading_root_preserve_reading_entries(self):
        state_paths = ["Notes/a.md", "Books/Apple Books/Author/Book/Annotations/one.md"]
        removed = compute_removed_paths(state_paths, current_paths=set(), notes_paths=["Notes"], reading_annotations_included=False)
        self.assertEqual(removed, ["Notes/a.md"])

    def test_runs_scanning_reading_root_without_including_annotations_still_preserve_reading_entries(self):
        # Even when the folder is nominally in scope (e.g. `Books` or `.` is a
        # configured scope folder), an ordinary current/all/manual/weekly run
        # never actually scans Reading annotations, so it must not treat an
        # untouched annotation as deleted just because this run excluded it.
        state_paths = ["Notes/a.md", "Books/Apple Books/Author/Book/Annotations/one.md"]
        removed = compute_removed_paths(state_paths, current_paths=set(), notes_paths=["Notes", READING_NOTES_ROOT], reading_annotations_included=False)
        self.assertEqual(removed, ["Notes/a.md"])

    def test_daily_include_reading_pending_runs_prune_missing_reading_entries(self):
        state_paths = ["Notes/a.md", "Books/Apple Books/Author/Book/Annotations/one.md"]
        removed = compute_removed_paths(state_paths, current_paths=set(), notes_paths=["Notes", READING_NOTES_ROOT], reading_annotations_included=True)
        self.assertEqual(set(removed), set(state_paths))

    def test_reading_entries_still_present_on_disk_are_never_removed(self):
        state_paths = ["Books/Apple Books/Author/Book/Annotations/one.md"]
        removed = compute_removed_paths(
            state_paths,
            current_paths={"Books/Apple Books/Author/Book/Annotations/one.md"},
            notes_paths=["Notes", READING_NOTES_ROOT],
            reading_annotations_included=True,
        )
        self.assertEqual(removed, [])

    def test_state_preservation_is_uniform_regardless_of_rebuild(self):
        # --rebuild's Chroma rows are preserved separately by
        # rebuild_collections_preserving_reading (see RebuildPreservesReadingRowsTests),
        # so compute_removed_paths does not need (and must not apply) a
        # rebuild-specific carve-out: state.json staying untouched for an
        # unscanned Reading entry is honest in both cases.
        state_paths = ["Notes/a.md", "Books/Apple Books/Author/Book/Annotations/one.md"]
        removed = compute_removed_paths(state_paths, current_paths=set(), notes_paths=["Notes"], reading_annotations_included=False)
        self.assertEqual(removed, ["Notes/a.md"])

    def test_generated_index_rows_are_always_prunable_even_when_annotations_are_protected(self):
        state_paths = ["Books/Apple Books/Author/Book/Index.md", "Books/Apple Books/Author/Book/Annotations/one.md"]
        removed = compute_removed_paths(state_paths, current_paths=set(), notes_paths=["Notes"], reading_annotations_included=False)
        self.assertEqual(removed, ["Books/Apple Books/Author/Book/Index.md"])

    def test_ordinary_non_annotation_notes_under_reading_root_are_never_protected(self):
        # A note dropped directly in a book folder (not under Annotations) is
        # not annotation-shaped, so it is never protected from cleanup just
        # because it lives under the Reading root.
        state_paths = ["Books/Apple Books/Author/Book/notes.md", "Books/Apple Books/Author/Book/Annotations/one.md"]
        removed = compute_removed_paths(state_paths, current_paths=set(), notes_paths=["Notes"], reading_annotations_included=False)
        self.assertEqual(removed, ["Books/Apple Books/Author/Book/notes.md"])


class ReadingArtifactShapeAndMarkerClassificationTests(unittest.TestCase):
    ANNOTATION_PATH = "Books/Apple Books/Author/Book/Annotations/one.md"
    INDEX_PATH = "Books/Apple Books/Author/Book/Index.md"
    COMPLETE_INDEX_TEXT = f"{READING_INDEX_START}\n## Apple Books Annotations\n{READING_INDEX_END}\n"

    def test_is_reading_annotation_relpath_requires_exact_author_book_annotations_shape(self):
        self.assertTrue(is_reading_annotation_relpath(self.ANNOTATION_PATH))
        # Missing the author level (only Book/Annotations/file.md).
        self.assertFalse(is_reading_annotation_relpath("Books/Apple Books/Book/Annotations/one.md"))
        # Nested one level too deep.
        self.assertFalse(is_reading_annotation_relpath("Books/Apple Books/Author/Book/Annotations/Sub/one.md"))
        # An ordinary note directly in the book folder (not under Annotations).
        self.assertFalse(is_reading_annotation_relpath("Books/Apple Books/Author/Book/notes.md"))
        # The generated index itself is not annotation-shaped.
        self.assertFalse(is_reading_annotation_relpath(self.INDEX_PATH))
        # Outside the Reading root entirely.
        self.assertFalse(is_reading_annotation_relpath("Notes/Author/Book/Annotations/one.md"))

    def test_is_reading_index_relpath_requires_exact_author_book_index_shape(self):
        self.assertTrue(is_reading_index_relpath(self.INDEX_PATH))
        self.assertFalse(is_reading_index_relpath(self.ANNOTATION_PATH))
        self.assertFalse(is_reading_index_relpath("Books/Apple Books/Author/Index.md"))
        self.assertFalse(is_reading_index_relpath("Books/Apple Books/Author/Book/Sub/Index.md"))

    def test_generated_index_requires_exactly_one_start_and_one_end_marker_in_order(self):
        self.assertTrue(is_generated_reading_index(self.INDEX_PATH, self.COMPLETE_INDEX_TEXT))
        # Reversed order: end before start.
        reversed_text = f"{READING_INDEX_END}\nnotes\n{READING_INDEX_START}"
        self.assertFalse(is_generated_reading_index(self.INDEX_PATH, reversed_text))
        # Duplicate start marker.
        duplicate_start = f"{READING_INDEX_START}\n{READING_INDEX_START}\n{READING_INDEX_END}"
        self.assertFalse(is_generated_reading_index(self.INDEX_PATH, duplicate_start))
        # Duplicate end marker.
        duplicate_end = f"{READING_INDEX_START}\n{READING_INDEX_END}\n{READING_INDEX_END}"
        self.assertFalse(is_generated_reading_index(self.INDEX_PATH, duplicate_end))
        # Orphan start marker only.
        self.assertFalse(is_generated_reading_index(self.INDEX_PATH, f"{READING_INDEX_START}\nnotes\n"))
        # Orphan end marker only.
        self.assertFalse(is_generated_reading_index(self.INDEX_PATH, f"notes\n{READING_INDEX_END}"))
        # No markers at all: an unrelated user-authored Index.md.
        self.assertFalse(is_generated_reading_index(self.INDEX_PATH, "# My own index\n"))
        # Complete pair but wrong structural location.
        self.assertFalse(is_generated_reading_index(self.ANNOTATION_PATH, self.COMPLETE_INDEX_TEXT))


class RebuildPreservesReadingRowsTests(unittest.TestCase):
    class FakeChromaCollection:
        def __init__(self):
            self.rows = {}

        def get(self, where=None, include=None):
            target_path = (where or {}).get("path")
            ids, embeddings, metadatas, documents = [], [], [], []
            for row_id, (embedding, metadata, document) in self.rows.items():
                if target_path is not None and metadata.get("path") != target_path:
                    continue
                ids.append(row_id)
                embeddings.append(embedding)
                metadatas.append(metadata)
                documents.append(document)
            return {"ids": ids, "embeddings": embeddings, "metadatas": metadatas, "documents": documents}

        def add(self, ids, embeddings, metadatas, documents):
            for row_id, embedding, metadata, document in zip(ids, embeddings, metadatas, documents):
                self.rows[row_id] = (embedding, metadata, document)

        def count(self):
            return len(self.rows)

    class FakeChromaClient:
        def __init__(self):
            self.collections = {}
            self.calls = []

        def get_or_create_collection(self, name, metadata=None):
            self.calls.append(("get_or_create_collection", name))
            if name not in self.collections:
                self.collections[name] = RebuildPreservesReadingRowsTests.FakeChromaCollection()
            return self.collections[name]

        def delete_collection(self, name):
            self.calls.append(("delete_collection", name))
            self.collections.pop(name, None)

    READING_PATH = "Books/Apple Books/Author/Book/Annotations/one.md"

    def _seed_client(self) -> "RebuildPreservesReadingRowsTests.FakeChromaClient":
        client = self.FakeChromaClient()
        chunks = client.get_or_create_collection("mindmap_chunks")
        notes_col = client.get_or_create_collection("mindmap_notes")
        chunks.add(
            ids=[f"{self.READING_PATH}::chunk::0"],
            embeddings=[[0.1, 0.2]],
            metadatas=[{"path": self.READING_PATH, "chunk": 0}],
            documents=["A quote."],
        )
        notes_col.add(
            ids=[f"{self.READING_PATH}::note"],
            embeddings=[[0.1, 0.2]],
            metadatas=[{"path": self.READING_PATH, "title": "one"}],
            documents=["A quote."],
        )
        chunks.add(
            ids=["Notes/other.md::chunk::0"],
            embeddings=[[0.5]],
            metadatas=[{"path": "Notes/other.md", "chunk": 0}],
            documents=["Unrelated note."],
        )
        client.calls.clear()
        return client

    def test_reading_paths_excluded_from_rebuild_scan_are_always_preserved(self):
        # --include-reading-pending (the only profile that scans Reading
        # annotations) is mutually exclusive with --rebuild, so a rebuild
        # never re-scans annotations itself regardless of configured scope;
        # every tracked annotation row must always be preserved.
        state_paths = ["Notes/a.md", self.READING_PATH]
        self.assertEqual(reading_paths_excluded_from_rebuild_scan(state_paths), [self.READING_PATH])
        self.assertEqual(
            reading_paths_excluded_from_rebuild_scan(["Notes/a.md", self.READING_PATH, "Books/Apple Books/Author/Book/Index.md"]),
            [self.READING_PATH],
        )

    def test_rebuild_preserves_tracked_reading_rows_across_delete_and_recreate(self):
        client = self._seed_client()

        new_chunks, new_notes = rebuild_collections_preserving_reading(
            client, "mindmap_chunks", "mindmap_notes", [self.READING_PATH], {},
        )

        self.assertIn(("delete_collection", "mindmap_chunks"), client.calls)
        self.assertIn(("delete_collection", "mindmap_notes"), client.calls)
        preserved_chunk = new_chunks.get(where={"path": self.READING_PATH})
        self.assertEqual(preserved_chunk["ids"], [f"{self.READING_PATH}::chunk::0"])
        self.assertEqual(preserved_chunk["embeddings"], [[0.1, 0.2]])
        self.assertEqual(new_notes.count(), 1)
        # A non-Reading row that this rebuild does scan/re-tag itself is not
        # part of the preservation snapshot; it is expected to be
        # repopulated later by the normal indexing pass, not restored here.
        self.assertEqual(new_chunks.get(where={"path": "Notes/other.md"})["ids"], [])

    def test_snapshot_reads_happen_before_any_delete_collection_call(self):
        client = self._seed_client()

        rebuild_collections_preserving_reading(client, "mindmap_chunks", "mindmap_notes", [self.READING_PATH], {})

        first_delete_index = next(i for i, call in enumerate(client.calls) if call[0] == "delete_collection")
        calls_before_delete = client.calls[:first_delete_index]
        self.assertTrue(any(call[0] == "get_or_create_collection" for call in calls_before_delete))

    def test_no_tracked_reading_paths_skips_snapshot_entirely(self):
        client = self._seed_client()

        rebuild_collections_preserving_reading(client, "mindmap_chunks", "mindmap_notes", [], {})

        get_calls = [call for call in client.calls if call[0] == "get_or_create_collection"]
        # Only the post-delete recreation calls, no pre-delete snapshot fetch.
        self.assertEqual(len(get_calls), 2)

    def test_snapshot_read_failure_aborts_before_any_deletion(self):
        class FailingCollection(RebuildPreservesReadingRowsTests.FakeChromaCollection):
            def get(self, where=None, include=None):
                raise RuntimeError("boom")

        client = self.FakeChromaClient()
        client.collections["mindmap_chunks"] = FailingCollection()
        client.collections["mindmap_notes"] = self.FakeChromaCollection()

        with self.assertRaises(RuntimeError) as ctx:
            rebuild_collections_preserving_reading(client, "mindmap_chunks", "mindmap_notes", [self.READING_PATH], {})

        self.assertIn("REBUILD_READING_PRESERVATION_FAILED", str(ctx.exception))
        self.assertEqual([call for call in client.calls if call[0] == "delete_collection"], [])

    def test_missing_tracked_rows_abort_before_any_deletion(self):
        client = self.FakeChromaClient()
        chunks = client.get_or_create_collection("mindmap_chunks")
        client.get_or_create_collection("mindmap_notes")
        chunks.add(
            ids=[f"{self.READING_PATH}::chunk::0"],
            embeddings=[[0.1, 0.2]],
            metadatas=[{"path": self.READING_PATH, "chunk": 0}],
            documents=["A quote."],
        )
        client.calls.clear()

        with self.assertRaises(RuntimeError) as ctx:
            rebuild_collections_preserving_reading(
                client, "mindmap_chunks", "mindmap_notes", [self.READING_PATH], {},
            )

        self.assertIn("REBUILD_READING_PRESERVATION_FAILED", str(ctx.exception))
        self.assertEqual([call for call in client.calls if call[0] == "delete_collection"], [])

    def test_restore_failure_surfaces_an_actionable_diagnostic(self):
        client = self._seed_client()
        acquisitions = {"mindmap_chunks": 0}
        original_get_or_create = client.get_or_create_collection

        def flaky_get_or_create(name, metadata=None):
            collection = original_get_or_create(name, metadata)
            if name == "mindmap_chunks":
                acquisitions["mindmap_chunks"] += 1
                if acquisitions["mindmap_chunks"] == 2:
                    class FailingAdd:
                        def get(self, **kwargs):
                            return collection.get(**kwargs)

                        def add(self, **kwargs):
                            raise RuntimeError("disk full")
                    return FailingAdd()
            return collection

        client.get_or_create_collection = flaky_get_or_create

        with self.assertRaises(RuntimeError) as ctx:
            rebuild_collections_preserving_reading(client, "mindmap_chunks", "mindmap_notes", [self.READING_PATH], {})

        self.assertIn("REBUILD_READING_RESTORE_FAILED", str(ctx.exception))


class AppleAnnotationWikilinkTests(unittest.TestCase):
    def test_concept_wikilink_wraps_normal_text(self):
        self.assertEqual(apple_annotation_concept_wikilink("Behavior change"), "[[Behavior change]]")

    def test_concept_wikilink_sanitizes_wikilink_and_path_unsafe_characters(self):
        self.assertEqual(apple_annotation_concept_wikilink("Weird [[link]] | pipe"), "[[Weird -link- - pipe]]")
        self.assertNotIn("[", apple_annotation_concept_wikilink("a[b")[2:-2])
        self.assertNotIn("|", apple_annotation_concept_wikilink("a|b"))

    def test_concept_wikilink_falls_back_when_unusable(self):
        self.assertEqual(apple_annotation_concept_wikilink("   "), "[[Concept]]")
        self.assertEqual(apple_annotation_concept_wikilink("..."), "[[Concept]]")
        self.assertEqual(apple_annotation_concept_wikilink(""), "[[Concept]]")

    def test_concept_wikilink_bounds_length(self):
        link = apple_annotation_concept_wikilink("x" * 200)
        self.assertLessEqual(len(link) - 4, 80)

    def test_concept_wikilink_preserves_unicode(self):
        self.assertEqual(apple_annotation_concept_wikilink("Café résumé"), "[[Café résumé]]")

    def test_concept_wikilinks_deduplicates(self):
        self.assertEqual(
            apple_annotation_concept_wikilinks(["Teaching", "teaching".title(), "Teaching"]),
            ["[[Teaching]]"],
        )

    def test_related_wikilink_strips_extension_and_uses_basename_label(self):
        link = apple_annotation_related_wikilink("Books/Apple Books/Author/Book/Annotations/Overcoming ingrained habits.md")
        self.assertEqual(
            link,
            "[[Books/Apple Books/Author/Book/Annotations/Overcoming ingrained habits|Overcoming ingrained habits]]",
        )

    def test_related_wikilink_preserves_valid_unicode_paths(self):
        link = apple_annotation_related_wikilink("Books/Apple Books/Café Author/Book/Annotations/Café note.md")
        self.assertEqual(
            link,
            "[[Books/Apple Books/Café Author/Book/Annotations/Café note|Café note]]",
        )

    def test_related_wikilink_rejects_unsafe_targets_instead_of_sanitizing(self):
        unsafe = (
            "/absolute/Notes/one.md",
            "C:/Notes/one.md",
            "\\\\server\\share\\one.md",
            "../outside.md",
            "Books/Apple Books/../../etc/passwd.md",
            ".obsidian/plugins/mindmap-ai/data.md",
            "Books/Apple Books/.obsidian/note.md",
            "Notes/one.txt",
            "Notes/one",
            "Notes/o[ne].md",
            "Notes/o|ne.md",
            "Notes/o\nne.md",
            "Notes/o\x01ne.md",
            "",
            "   ",
        )
        for candidate in unsafe:
            with self.subTest(candidate=candidate):
                self.assertEqual(apple_annotation_related_wikilink(candidate), "")

    def test_related_wikilinks_deduplicates_and_drops_unsafe_entries(self):
        result = apple_annotation_related_wikilinks(["Notes/a.md", "Notes/a.md", "", "../outside.md"])
        self.assertEqual(result, ["[[Notes/a|a]]"])


class BuildMetadataUpdatesTests(unittest.TestCase):
    def _note(self, is_apple_annotation: bool) -> Note:
        return Note(path=Path("x.md"), relpath="x.md", title="x", body="body", is_apple_annotation=is_apple_annotation)

    def test_ordinary_note_keeps_plain_summary_and_tags(self):
        updates = build_metadata_updates(self._note(False), "Summary text", ["tag-one"], ["Concept One"], ["Notes/other.md"])
        self.assertEqual(updates, {
            "summary": "Summary text",
            "tags": ["tag-one"],
            "concepts": ["Concept One"],
            "related": ["Notes/other.md"],
        })

    def test_apple_annotation_note_omits_summary_and_tags_and_uses_wikilinks(self):
        updates = build_metadata_updates(
            self._note(True),
            "Summary text",
            ["tag-one"],
            ["Concept One"],
            ["Books/Apple Books/Author/Book/Annotations/Other.md"],
        )
        self.assertNotIn("summary", updates)
        self.assertNotIn("tags", updates)
        self.assertEqual(updates["concepts"], ["[[Concept One]]"])
        self.assertEqual(
            updates["related"],
            ["[[Books/Apple Books/Author/Book/Annotations/Other|Other]]"],
        )


class ApplyNoteFrontmatterWriteTests(unittest.TestCase):
    """Exercises the real write seam (`apply_note_frontmatter_write`), the
    same function `write_note_update` delegates to, end to end."""

    def _annotation_note(self, relpath="Books/Apple Books/Author/Book/Annotations/Quote.md") -> Note:
        return Note(path=Path(relpath), relpath=relpath, title="Quote", body="quote", is_apple_annotation=True)

    def test_clears_existing_summary_and_tags_preserves_unrelated_and_research_link(self):
        original = (
            "---\n"
            "type: apple-books-annotation\n"
            "annotation_id: abc123\n"
            "book_title: The Book\n"
            "summary: Old generated summary\n"
            "tags:\n"
            "  - old-tag\n"
            'research: "[[Books/Apple Books/Author/Book/Research/Quote|Research]]"\n'
            "---\n"
            "> A quote worth remembering.\n"
        )
        note = self._annotation_note()
        updates = build_metadata_updates(note, "New summary", ["new-tag"], ["Concept One"], ["Books/Apple Books/Author/Book/Annotations/Other.md"])

        updated = apply_note_frontmatter_write(
            original, note, updates, ["summary", "tags", "concepts", "related"], "## Mindmap", True, False,
        )
        frontmatter, body = split_frontmatter(updated)

        self.assertNotIn("summary", frontmatter)
        self.assertNotIn("tags", frontmatter)
        self.assertNotIn("old-tag", updated)
        self.assertNotIn("Old generated summary", updated)
        self.assertIn("annotation_id: abc123", frontmatter)
        self.assertIn("book_title: The Book", frontmatter)
        self.assertIn("[[Books/Apple Books/Author/Book/Research/Quote|Research]]", frontmatter)
        self.assertIn("[[Concept One]]", frontmatter)
        self.assertIn("[[Books/Apple Books/Author/Book/Annotations/Other|Other]]", frontmatter)
        self.assertEqual(body.strip(), "> A quote worth remembering.")

    def test_never_appends_a_mindmap_section_even_when_write_mindmap_section_is_enabled(self):
        original = "---\ntype: apple-books-annotation\n---\n> A quote.\n"
        note = self._annotation_note()
        updates = build_metadata_updates(note, "", [], [], ["Notes/other.md"])

        updated = apply_note_frontmatter_write(
            original, note, updates, ["summary", "tags", "concepts", "related"], "## Mindmap", True, False,
            related_items=[("Notes/other.md", "core")],
        )

        self.assertNotIn("Mindmap", updated.split("---", 2)[-1])
        self.assertNotIn("[!mindmap]", updated)

    def test_removes_an_existing_managed_mindmap_section_from_the_body(self):
        original = (
            "---\ntype: apple-books-annotation\n---\n"
            "> A quote.\n"
            "\n---\n\n"
            "> [!mindmap]- Mindmap\n"
            "> - <span class=\"mindmap-link is-core\">[[Notes/old|old]]</span>\n"
        )
        note = self._annotation_note()
        updates = build_metadata_updates(note, "", [], [], [])

        for write_mindmap_section in (True, False):
            updated = apply_note_frontmatter_write(
                original, note, updates, ["summary", "tags", "concepts", "related"], "## Mindmap",
                write_mindmap_section, False,
            )
            self.assertNotIn("[!mindmap]", updated)
            self.assertNotIn("Notes/old", updated)
            _fm, body = split_frontmatter(updated)
            self.assertEqual(body.strip(), "> A quote.")

    def test_preserves_crlf_body_bytes_when_nothing_managed_needs_to_change(self):
        original = "---\r\ntype: apple-books-annotation\r\n---\r\n> A quote.\r\nMore user content.\r\n"
        note = self._annotation_note()
        updates = build_metadata_updates(note, "", [], [], [])

        updated = apply_note_frontmatter_write(
            original, note, updates, ["summary", "tags", "concepts", "related"], "## Mindmap", True, False,
        )

        _fm, original_body = split_frontmatter(original)
        _fm2, updated_body = split_frontmatter(updated)
        self.assertEqual(updated_body, original_body)
        self.assertIn("\r\n", updated_body)

    def test_end_to_end_write_through_real_temp_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            target = Path(tmpdir) / "Quote.md"
            original = (
                "---\r\n"
                "type: apple-books-annotation\r\n"
                "annotation_id: abc123\r\n"
                "summary: stale\r\n"
                "tags:\r\n"
                "  - stale-tag\r\n"
                "---\r\n"
                "> A quote worth keeping.\r\n"
                "\r\n"
                "User-added follow-up thoughts.\r\n"
            )
            target.write_bytes(original.encode("utf-8"))

            note = Note(path=target, relpath="Quote.md", title="Quote", body="quote", is_apple_annotation=True)
            updates = build_metadata_updates(note, "", [], ["Habit formation"], ["Books/Apple Books/A/B/Annotations/Other.md"])

            read_back = target.read_text(encoding="utf-8", errors="ignore")
            updated = apply_note_frontmatter_write(
                read_back, note, updates, ["summary", "tags", "concepts", "related"], "## Mindmap", False, False,
            )
            self.assertNotEqual(updated, read_back)
            target.write_text(updated, encoding="utf-8")

            final = target.read_text(encoding="utf-8")
            frontmatter, body = split_frontmatter(final)
            self.assertNotIn("stale", frontmatter)
            self.assertNotIn("summary", frontmatter)
            self.assertNotIn("tags", frontmatter)
            self.assertIn("[[Habit formation]]", frontmatter)
            self.assertIn("[[Books/Apple Books/A/B/Annotations/Other|Other]]", frontmatter)
            self.assertIn("A quote worth keeping.", body)
            self.assertIn("User-added follow-up thoughts.", body)
            # Note: Path.read_text() applies universal-newline translation on
            # read (a project-wide, pre-existing characteristic of every note
            # read this way, not specific to annotations), so CRLF bytes on
            # disk normalize to LF before apply_note_frontmatter_write ever
            # sees them. True byte-for-byte CRLF preservation is covered at
            # the function level in test_preserves_crlf_body_bytes_*.


if __name__ == "__main__":
    unittest.main()
