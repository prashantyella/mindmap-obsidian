import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures"))

from apple_books_fixture import build_fixture  # noqa: E402
from apple_books_reader import (  # noqa: E402
    EXIT_SUCCESS,
    EXIT_PERMISSION_DENIED,
    EXIT_UNAVAILABLE,
    EXIT_UNSUPPORTED_SCHEMA,
    ReaderConfig,
    check_access,
    load_reader_config,
    main,
    read_annotations,
)


def source_digest(path: Path) -> dict[str, str]:
    files = [path, Path(f"{path}-wal"), Path(f"{path}-shm")]
    result = {}
    for file_path in files:
        if file_path.exists():
            result[file_path.name] = hashlib.sha256(file_path.read_bytes()).hexdigest()
    return result


class AppleBooksReaderTests(unittest.TestCase):
    def test_joined_schema_normalizes_annotation_and_title_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            annotation, _library = build_fixture(Path(temp), "joined")
            before = source_digest(annotation)

            result = read_annotations(ReaderConfig(annotation_db_path=annotation))

            self.assertEqual(result["status"], "success")
            self.assertEqual(result["count"], 1)
            item = result["annotations"][0]
            self.assertEqual(item["annotation_id"], "aeannotation:uuid-1")
            self.assertEqual(item["quote"], "A useful highlighted passage.")
            self.assertEqual(item["user_note"], "A personal note.")
            self.assertEqual(item["book_title"], "The Quiet Book")
            self.assertEqual(item["author"], "A. Reader")
            self.assertEqual(item["chapter"], "Chapter One")
            self.assertEqual(item["location"], "42")
            self.assertTrue(item["created_at"].endswith("Z"))
            self.assertTrue(item["modified_at"].endswith("Z"))
            self.assertEqual(source_digest(annotation), before)

    def test_uuid_identity_survives_local_row_id_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            annotation, _library = build_fixture(Path(temp), "joined")
            first = read_annotations(ReaderConfig(annotation_db_path=annotation))
            connection = sqlite3.connect(annotation)
            connection.execute("UPDATE ZAEANNOTATION SET Z_PK = 101 WHERE ZANNOTATIONUUID = 'uuid-1'")
            connection.commit()
            connection.close()

            second = read_annotations(ReaderConfig(annotation_db_path=annotation))

            self.assertEqual(first["annotations"][0]["annotation_id"], "aeannotation:uuid-1")
            self.assertEqual(second["annotations"][0]["annotation_id"], "aeannotation:uuid-1")

    def test_partial_rows_are_usable_and_return_zero_exit(self):
        with tempfile.TemporaryDirectory() as temp:
            annotation, _library = build_fixture(Path(temp), "joined", partial=True)
            result = read_annotations(ReaderConfig(annotation_db_path=annotation))

            self.assertEqual(result["status"], "partial")
            self.assertEqual(result["count"], 1)
            self.assertEqual(result["skipped_rows"], 1)
            with patch("sys.argv", ["apple_books_reader.py", "--annotation-db", str(annotation)]):
                with patch("builtins.print"):
                    self.assertEqual(main(), EXIT_SUCCESS)

    def test_all_malformed_rows_keep_nonzero_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            annotation, _library = build_fixture(Path(temp), "joined", malformed=True)
            result = read_annotations(ReaderConfig(annotation_db_path=annotation))

            self.assertEqual(result["status"], "malformed_rows")
            self.assertEqual(result["count"], 0)
            self.assertEqual(result["skipped_rows"], 1)
            self.assertEqual(
                result["diagnostics"][0]["guidance"],
                "Valid annotations remain usable. Retry after Apple Books finishes updating; if the issue persists, report an unsupported schema.",
            )
            with patch("sys.argv", ["apple_books_reader.py", "--annotation-db", str(annotation)]):
                with patch("builtins.print"):
                    self.assertEqual(main(), 13)

    def test_asset_schema_enriches_title_and_author_from_library_database(self):
        with tempfile.TemporaryDirectory() as temp:
            annotation, library = build_fixture(Path(temp), "asset-enriched")
            result = read_annotations(ReaderConfig(annotation_db_path=annotation, library_db_path=library))

            self.assertEqual(result["status"], "success")
            self.assertEqual(result["count"], 1)
            item = result["annotations"][0]
            self.assertEqual(item["book_title"], "The Other Book")
            self.assertEqual(item["author"], "B. Writer")
            self.assertEqual(item["location"], "88")
            self.assertEqual({source["role"] for source in result["sources"]}, {"annotations", "library"})

    def test_wal_snapshot_reads_committed_activity_without_changing_source(self):
        with tempfile.TemporaryDirectory() as temp:
            annotation, _library = build_fixture(Path(temp), "joined")
            writer = sqlite3.connect(annotation)
            try:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.execute("UPDATE ZAEANNOTATION SET ZANNOTATIONSELECTEDTEXT = ? WHERE Z_PK = 1", ("WAL updated passage.",))
                writer.commit()
                before = source_digest(annotation)
                result = read_annotations(ReaderConfig(annotation_db_path=annotation))
                after = source_digest(annotation)
            finally:
                writer.close()

            self.assertEqual(result["annotations"][0]["quote"], "WAL updated passage.")
            self.assertEqual(after, before)

    def test_empty_database_is_success_with_zero_annotations(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "AEAnnotation.sqlite"
            connection = sqlite3.connect(path)
            connection.execute("CREATE TABLE ZAEANNOTATION (Z_PK INTEGER PRIMARY KEY, ZANNOTATIONSELECTEDTEXT TEXT)")
            connection.commit()
            connection.close()

            result = read_annotations(ReaderConfig(annotation_db_path=path))

            self.assertEqual(result["status"], "success")
            self.assertEqual(result["count"], 0)
            self.assertEqual(result["annotations"], [])

    def test_unsupported_schema_has_structured_status_and_exit_code(self):
        with tempfile.TemporaryDirectory() as temp:
            annotation, _library = build_fixture(Path(temp), "unsupported")

            result = read_annotations(ReaderConfig(annotation_db_path=annotation))

            self.assertEqual(result["status"], "unsupported_schema")
            self.assertEqual(result["diagnostics"][0]["code"], "APPLE_BOOKS_SCHEMA_UNSUPPORTED")
            with patch("sys.argv", ["apple_books_reader.py", "--annotation-db", str(annotation)]):
                self.assertEqual(main(), EXIT_UNSUPPORTED_SCHEMA)

    def test_missing_database_is_unavailable_without_exposing_path(self):
        with tempfile.TemporaryDirectory() as temp:
            missing = Path(temp) / "secret" / "AEAnnotation.sqlite"
            result = read_annotations(ReaderConfig(annotation_db_path=missing))

            self.assertEqual(result["status"], "unavailable")
            serialized = json.dumps(result)
            self.assertNotIn(str(missing), serialized)
            with patch("sys.argv", ["apple_books_reader.py", "--annotation-db", str(missing)]):
                self.assertEqual(main(), EXIT_UNAVAILABLE)

    def test_preflight_report_never_contains_annotation_text(self):
        with tempfile.TemporaryDirectory() as temp:
            annotation, _library = build_fixture(Path(temp), "joined")
            with patch("sys.argv", ["apple_books_reader.py", "--preflight", "--annotation-db", str(annotation)]):
                with patch("builtins.print") as print_mock:
                    self.assertEqual(main(), EXIT_SUCCESS)
            report = print_mock.call_args.args[0]
            self.assertNotIn("A useful highlighted passage", report)
            self.assertIn('"status": "success"', report)

    def test_partial_preflight_is_path_free_and_usable(self):
        with tempfile.TemporaryDirectory() as temp:
            annotation, _library = build_fixture(Path(temp), "joined", partial=True)
            with patch("sys.argv", ["apple_books_reader.py", "--preflight", "--annotation-db", str(annotation)]):
                with patch("builtins.print") as print_mock:
                    self.assertEqual(main(), EXIT_SUCCESS)
            report = print_mock.call_args.args[0]
            self.assertIn('"status": "partial"', report)
            self.assertIn('"skipped_rows": 1', report)
            self.assertNotIn("A useful highlighted passage", report)

    def test_permission_denied_is_distinguished_without_exposing_path(self):
        with tempfile.TemporaryDirectory() as temp:
            annotation, _library = build_fixture(Path(temp), "joined")
            with patch.object(Path, "stat", side_effect=PermissionError("denied")):
                result = read_annotations(ReaderConfig(annotation_db_path=annotation))

            self.assertEqual(result["status"], "permission_denied")
            self.assertEqual(result["diagnostics"][0]["code"], "APPLE_BOOKS_PERMISSION_DENIED")
            self.assertNotIn(str(annotation), json.dumps(result))
            with patch("sys.argv", ["apple_books_reader.py", "--annotation-db", str(annotation)]):
                with patch.object(Path, "stat", side_effect=PermissionError("denied")):
                    with patch("builtins.print"):
                        self.assertEqual(main(), EXIT_PERMISSION_DENIED)

    def test_config_overrides_are_explicit_and_nested(self):
        with tempfile.TemporaryDirectory() as temp:
            config_path = Path(temp) / "config.json"
            config_path.write_text(json.dumps({"apple_books": {
                "annotation_database_path": "/private/annotation.sqlite",
                "library_database_path": "/private/library.sqlite",
            }}), encoding="utf-8")

            config = load_reader_config(config_path)

            self.assertEqual(config.annotation_db_path, Path("/private/annotation.sqlite"))
            self.assertEqual(config.library_db_path, Path("/private/library.sqlite"))


if __name__ == "__main__":
    unittest.main()
