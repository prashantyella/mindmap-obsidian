#!/usr/bin/env python3
"""Read Apple Books annotations without modifying Apple-owned databases.

The reader deliberately has no third-party dependencies. It discovers the
known Apple Books database locations, opens them read-only, copies each source
into an in-memory SQLite backup, and only queries the in-memory snapshot.
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional


RESPONSE_VERSION = 1
EXIT_SUCCESS = 0
EXIT_UNAVAILABLE = 10
EXIT_PERMISSION_DENIED = 11
EXIT_UNSUPPORTED_SCHEMA = 12
EXIT_MALFORMED_ROWS = 13
EXIT_SOURCE_CHANGING = 14
EXIT_INVALID_CONFIG = 64

_CF_EPOCH = 978307200
_SAFE_FILENAME = re.compile(r"^[^/\\]+$")


class ReaderFailure(Exception):
    """A user-safe reader failure with a stable status and diagnostic code."""

    def __init__(self, status: str, code: str, message: str, guidance: str, exit_code: int):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.guidance = guidance
        self.exit_code = exit_code


@dataclass(frozen=True)
class ReaderConfig:
    annotation_db_path: Optional[Path] = None
    library_db_path: Optional[Path] = None
    home: Optional[Path] = None
    snapshot_retries: int = 3


@dataclass(frozen=True)
class SourceMetadata:
    role: str
    filename: str
    schema: str
    snapshot: str
    wal_present: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "filename": self.filename,
            "schema": self.schema,
            "snapshot": self.snapshot,
            "wal_present": self.wal_present,
        }


def _diagnostic(code: str, message: str, guidance: str, *, severity: str = "error") -> dict[str, str]:
    return {
        "severity": severity,
        "code": code,
        "message": message,
        "guidance": guidance,
    }


def _response(
    status: str,
    annotations: Optional[list[dict[str, Any]]] = None,
    diagnostics: Optional[list[dict[str, str]]] = None,
    sources: Optional[list[SourceMetadata]] = None,
    skipped_rows: int = 0,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "version": RESPONSE_VERSION,
        "status": status,
        "annotations": annotations or [],
        "diagnostics": diagnostics or [],
        "count": len(annotations or []),
    }
    if skipped_rows:
        payload["skipped_rows"] = skipped_rows
    if sources:
        payload["sources"] = [source.as_dict() for source in sources]
    return payload


def _config_value(config: dict[str, Any], *keys: str) -> Optional[str]:
    for key in keys:
        value = config.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    nested = config.get("apple_books")
    if isinstance(nested, dict):
        for key in keys:
            value = nested.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def load_reader_config(config_path: Optional[Path] = None, *, annotation_db: Optional[str] = None, library_db: Optional[str] = None) -> ReaderConfig:
    config: dict[str, Any] = {}
    if config_path is not None:
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise ReaderFailure(
                "invalid_config",
                "APPLE_BOOKS_CONFIG_MISSING",
                "Apple Books reader config was not found.",
                "Provide a valid runtime config path or use the bundled config.",
                EXIT_INVALID_CONFIG,
            ) from exc
        except (OSError, json.JSONDecodeError, TypeError) as exc:
            raise ReaderFailure(
                "invalid_config",
                "APPLE_BOOKS_CONFIG_INVALID",
                "Apple Books reader config could not be read as JSON.",
                "Fix the runtime config JSON and retry the Apple Books check.",
                EXIT_INVALID_CONFIG,
            ) from exc
        if not isinstance(config, dict):
            raise ReaderFailure(
                "invalid_config",
                "APPLE_BOOKS_CONFIG_INVALID",
                "Apple Books reader config must be a JSON object.",
                "Fix the runtime config JSON and retry the Apple Books check.",
                EXIT_INVALID_CONFIG,
            )

    annotation_value = annotation_db or _config_value(
        config,
        "annotation_database_path",
        "annotation_db_path",
        "apple_books_annotation_database_path",
        "apple_books_annotation_db_path",
    ) or os.environ.get("APPLE_BOOKS_ANNOTATION_DB_PATH")
    library_value = library_db or _config_value(
        config,
        "library_database_path",
        "library_db_path",
        "apple_books_library_database_path",
        "apple_books_library_db_path",
    ) or os.environ.get("APPLE_BOOKS_LIBRARY_DB_PATH")
    return ReaderConfig(
        annotation_db_path=Path(annotation_value).expanduser() if annotation_value else None,
        library_db_path=Path(library_value).expanduser() if library_value else None,
    )


def _home(config: ReaderConfig) -> Path:
    return config.home or Path(os.environ.get("HOME") or os.environ.get("USERPROFILE") or Path.home())


def _existing(paths: Iterable[Path]) -> Optional[Path]:
    for candidate in paths:
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            continue
    return None


def discover_annotation_database(config: ReaderConfig) -> Optional[Path]:
    if config.annotation_db_path is not None:
        return config.annotation_db_path
    home = _home(config)
    candidates = [
        home / "Library/Group Containers/27N4MQEA55.com.apple.iBooks/Documents/AEAnnotation/AEAnnotation.sqlite",
        home / "Library/Containers/com.apple.iBooksX/Data/Documents/AEAnnotation/AEAnnotation.sqlite",
        home / "Library/Containers/com.apple.iBooksX/Data/Documents/AEAnnotation/AEAnnotation_v2.sqlite",
    ]
    found = _existing(candidates)
    if found:
        return found
    for base in (
        home / "Library/Group Containers/27N4MQEA55.com.apple.iBooks/Documents/AEAnnotation",
        home / "Library/Containers/com.apple.iBooksX/Data/Documents/AEAnnotation",
    ):
        try:
            matches = sorted(path for path in base.iterdir() if path.is_file() and re.match(r"^AEAnnotation.*\.sqlite$", path.name, re.I))
        except OSError:
            continue
        if matches:
            return matches[0]
    return None


def discover_library_database(config: ReaderConfig, annotation_path: Optional[Path] = None) -> Optional[Path]:
    if config.library_db_path is not None:
        return config.library_db_path
    if annotation_path is not None:
        docs_dir = annotation_path.parent.parent
        bk_dir = docs_dir / "BKLibrary"
        relative_candidates = [docs_dir / "BKLibrary/BKLibrary.sqlite"]
        try:
            bk_dir_available = bk_dir.is_dir()
        except OSError:
            bk_dir_available = False
        if bk_dir_available:
            relative_candidates.extend(sorted(bk_dir.glob("BKLibrary-*.sqlite")))
        relative = _existing(
            relative_candidates
        )
        if relative:
            return relative
    home = _home(config)
    return _existing(
        [
            home / "Library/Containers/com.apple.iBooksX/Data/Documents/BKLibrary/BKLibrary.sqlite",
            home / "Library/Containers/com.apple.iBooksX/Data/Documents/BKLibrary/BKLibrary-1-091020131601.sqlite",
        ]
    )


def _file_state(path: Path) -> tuple[tuple[str, int, int], ...]:
    paths = [path, Path(f"{path}-wal"), Path(f"{path}-shm")]
    state = []
    for candidate in paths:
        try:
            stat = candidate.stat()
        except FileNotFoundError:
            state.append((candidate.name, 0, 0))
        except OSError as exc:
            raise ReaderFailure(
                "permission_denied",
                "APPLE_BOOKS_PERMISSION_DENIED",
                "Apple Books database metadata could not be inspected.",
                "Grant Mindmap read access to Apple Books data, then retry.",
                EXIT_PERMISSION_DENIED,
            ) from exc
        else:
            state.append((candidate.name, stat.st_size, stat.st_mtime_ns))
    return tuple(state)


def _open_read_only(path: Path) -> sqlite3.Connection:
    try:
        uri = f"file:{path.resolve().as_uri().removeprefix('file:')}?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        connection.execute("PRAGMA query_only = ON")
        return connection
    except PermissionError as exc:
        raise ReaderFailure(
            "permission_denied",
            "APPLE_BOOKS_PERMISSION_DENIED",
            "Apple Books database access was denied.",
            "Grant Mindmap read access to Apple Books data, then retry.",
            EXIT_PERMISSION_DENIED,
        ) from exc
    except sqlite3.OperationalError as exc:
        message = str(exc).lower()
        if "permission" in message or "unable to open" in message:
            raise ReaderFailure(
                "permission_denied",
                "APPLE_BOOKS_PERMISSION_DENIED",
                "Apple Books database could not be opened for reading.",
                "Grant Mindmap read access to Apple Books data, then retry.",
                EXIT_PERMISSION_DENIED,
            ) from exc
        raise ReaderFailure(
            "unavailable",
            "APPLE_BOOKS_DATABASE_UNAVAILABLE",
            "Apple Books database could not be opened.",
            "Open Apple Books or configure a readable database path, then retry.",
            EXIT_UNAVAILABLE,
        ) from exc


def _snapshot(path: Path, retries: int) -> tuple[sqlite3.Connection, tuple[tuple[str, int, int], ...]]:
    try:
        path.stat()
    except FileNotFoundError as exc:
        raise ReaderFailure(
            "unavailable",
            "APPLE_BOOKS_DATABASE_UNAVAILABLE",
            "Apple Books database is unavailable.",
            "Open Apple Books or configure a readable database path, then retry.",
            EXIT_UNAVAILABLE,
        ) from exc
    except PermissionError as exc:
        raise ReaderFailure(
            "permission_denied",
            "APPLE_BOOKS_PERMISSION_DENIED",
            "Apple Books database access was denied.",
            "Grant Mindmap read access to Apple Books data, then retry.",
            EXIT_PERMISSION_DENIED,
        ) from exc
    except OSError as exc:
        if exc.errno == errno.EACCES:
            raise ReaderFailure(
                "permission_denied",
                "APPLE_BOOKS_PERMISSION_DENIED",
                "Apple Books database access was denied.",
                "Grant Mindmap read access to Apple Books data, then retry.",
                EXIT_PERMISSION_DENIED,
            ) from exc
        raise ReaderFailure(
            "unavailable",
            "APPLE_BOOKS_DATABASE_UNAVAILABLE",
            "Apple Books database metadata could not be inspected.",
            "Open Apple Books or configure a readable database path, then retry.",
            EXIT_UNAVAILABLE,
        ) from exc
    before = _file_state(path)
    for _attempt in range(max(1, retries)):
        source: Optional[sqlite3.Connection] = None
        snapshot = sqlite3.connect(":memory:")
        snapshot.row_factory = sqlite3.Row
        temp_dir: Optional[tempfile.TemporaryDirectory[str]] = None
        try:
            # Never open the Apple-owned file directly. SQLite may update a
            # WAL reader lock in -shm even for a read-only connection.
            temp_dir = tempfile.TemporaryDirectory(prefix="mindmap-apple-books-")
            copied_path = Path(temp_dir.name) / path.name
            shutil.copyfile(path, copied_path)
            for suffix in ("-wal", "-shm"):
                sidecar = Path(f"{path}{suffix}")
                if sidecar.exists():
                    shutil.copyfile(sidecar, Path(f"{copied_path}{suffix}"))
            source = _open_read_only(copied_path)
            source.backup(snapshot)
            snapshot.execute("PRAGMA query_only = ON")
            after = _file_state(path)
            if before == after:
                return snapshot, after
            before = after
        except ReaderFailure:
            snapshot.close()
            raise
        except PermissionError as exc:
            snapshot.close()
            raise ReaderFailure(
                "permission_denied",
                "APPLE_BOOKS_PERMISSION_DENIED",
                "Apple Books database bytes could not be copied for a read snapshot.",
                "Grant Mindmap read access to Apple Books data, then retry.",
                EXIT_PERMISSION_DENIED,
            ) from exc
        except sqlite3.DatabaseError as exc:
            snapshot.close()
            raise ReaderFailure(
                "unavailable",
                "APPLE_BOOKS_DATABASE_UNAVAILABLE",
                "Apple Books database could not be read as SQLite.",
                "Confirm the configured database is an Apple Books SQLite database, then retry.",
                EXIT_UNAVAILABLE,
            ) from exc
        finally:
            if source is not None:
                source.close()
            if temp_dir is not None:
                temp_dir.cleanup()
        snapshot.close()
    raise ReaderFailure(
        "source_changing",
        "APPLE_BOOKS_DATABASE_CHANGING",
        "Apple Books database changed while a read snapshot was being created.",
        "Retry after Apple Books finishes updating its annotations.",
        EXIT_SOURCE_CHANGING,
    )


def _quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _tables(connection: sqlite3.Connection) -> list[str]:
    rows = connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    return [str(row[0]) for row in rows if isinstance(row[0], str)]


def _find_table(connection: sqlite3.Connection, preferred: Iterable[str], contains: Optional[str] = None) -> Optional[str]:
    tables = _tables(connection)
    by_upper = {table.upper(): table for table in tables}
    for name in preferred:
        if name.upper() in by_upper:
            return by_upper[name.upper()]
    if contains:
        return sorted((table for table in tables if contains.upper() in table.upper()), key=str.upper)[0:1][0] if any(contains.upper() in table.upper() for table in tables) else None
    return None


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    rows = connection.execute(f"PRAGMA table_info({_quote_identifier(table)})").fetchall()
    return {str(row[1]).upper() for row in rows if len(row) > 1}


def _column(columns: set[str], *names: str) -> Optional[str]:
    for name in names:
        if name.upper() in columns:
            return name.upper()
    return None


def _value(row: sqlite3.Row | dict[str, Any], name: Optional[str]) -> Any:
    return row[name] if name else None


def _text(value: Any, *, field: str, required: bool = False) -> Optional[str]:
    if value is None:
        if required:
            raise ValueError(f"missing {field}")
        return None
    if not isinstance(value, (str, int, float)):
        raise ValueError(f"invalid {field}")
    result = str(value).replace("\x00", "").strip()
    if required and not result:
        raise ValueError(f"empty {field}")
    return result or None


def _timestamp(value: Any, *, field: str) -> Optional[str]:
    if value is None or value == "":
        return None
    try:
        seconds = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid {field}") from exc
    if seconds < 0 or seconds > 4_000_000_000:
        raise ValueError(f"invalid {field}")
    return datetime.fromtimestamp(seconds + _CF_EPOCH, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _author_from_row(row: sqlite3.Row | dict[str, Any], columns: set[str]) -> Optional[str]:
    direct = _text(_value(row, _column(columns, "ZAUTHOR")), field="author")
    if direct:
        return direct
    family = _text(_value(row, _column(columns, "ZAUTHORFAMILYNAME")), field="author")
    given = _text(_value(row, _column(columns, "ZAUTHORGIVENNAME")), field="author")
    if family and given:
        return f"{given} {family}"
    return family or given


def _source_metadata(path: Path, role: str, schema: str, state: tuple[tuple[str, int, int], ...]) -> SourceMetadata:
    return SourceMetadata(
        role=role,
        filename=path.name if _SAFE_FILENAME.match(path.name) else "apple-books.sqlite",
        schema=schema,
        snapshot="sqlite-backup-memory",
        wal_present=any(name.endswith("-wal") and size > 0 for name, size, _mtime in state),
    )


def _library_map(connection: sqlite3.Connection) -> dict[str, tuple[str, Optional[str]]]:
    table = _find_table(connection, ("ZBKLIBRARYASSET",), "BKLIBRARYASSET")
    if not table:
        return {}
    columns = _columns(connection, table)
    asset_id = _column(columns, "ZASSETID")
    title = _column(columns, "ZTITLE")
    if not asset_id or not title:
        return {}
    author = _column(columns, "ZAUTHOR")
    family = _column(columns, "ZAUTHORFAMILYNAME")
    given = _column(columns, "ZAUTHORGIVENNAME")
    select = [asset_id, title]
    for column in (author, family, given):
        if column:
            select.append(column)
    rows = connection.execute(
        f"SELECT {', '.join(_quote_identifier(column) for column in select)} FROM {_quote_identifier(table)}"
    ).fetchall()
    result: dict[str, tuple[str, Optional[str]]] = {}
    for row in rows:
        try:
            key = _text(row[asset_id], field="asset ID", required=True)
            book_title = _text(row[title], field="book title", required=True)
            author_value = _author_from_row(row, columns)
        except ValueError:
            continue
        result[key] = (book_title, author_value)
    return result


def _read_annotation_rows(
    connection: sqlite3.Connection,
    library_connection: Optional[sqlite3.Connection],
) -> tuple[list[dict[str, Any]], str, int]:
    annotation_table = _find_table(connection, ("ZAEANNOTATION", "ZANNOTATION"), "ANNOTATION")
    if not annotation_table:
        raise ReaderFailure(
            "unsupported_schema",
            "APPLE_BOOKS_SCHEMA_UNSUPPORTED",
            "Apple Books annotation schema is not recognized.",
            "Configure a supported AEAnnotation database and retry.",
            EXIT_UNSUPPORTED_SCHEMA,
        )
    annotation_columns = _columns(connection, annotation_table)
    identity_columns = [
        name for name in ("ZANNOTATIONUUID", "ZUUID", "ZANNOTATIONID", "Z_PK")
        if name in annotation_columns
    ]
    quote_column = _column(annotation_columns, "ZANNOTATIONSELECTEDTEXT", "ZANNOTATIONREPRESENTATIVETEXT")
    if not identity_columns or not quote_column:
        raise ReaderFailure(
            "unsupported_schema",
            "APPLE_BOOKS_SCHEMA_UNSUPPORTED",
            "Apple Books annotation table lacks the supported ID or quote columns.",
            "Use an Apple Books AEAnnotation database with annotation text and identity columns.",
            EXIT_UNSUPPORTED_SCHEMA,
        )
    note_column = _column(annotation_columns, "ZANNOTATIONNOTE")
    chapter_column = _column(annotation_columns, "ZANNOTATIONCHAPTER", "ZFUTUREPROOFING5")
    location_column = _column(annotation_columns, "ZPLLOCATIONRANGESTART", "ZANNOTATIONLOCATION")
    created_column = _column(annotation_columns, "ZCREATIONDATE", "ZANNOTATIONCREATIONDATE")
    modified_column = _column(annotation_columns, "ZMODIFICATIONDATE", "ZANNOTATIONMODIFICATIONDATE", "ZLASTMODIFICATIONDATE")
    book_fk = _column(annotation_columns, "ZANNOTATIONBOOK")
    asset_column = _column(annotation_columns, "ZANNOTATIONASSETID")

    book_table = _find_table(connection, ("ZAEBOOK", "ZBOOK"), "BOOK") if book_fk else None
    book_columns = _columns(connection, book_table) if book_table else set()
    library_books = _library_map(library_connection) if library_connection else {}
    select_columns = [*identity_columns, quote_column]
    for column in (note_column, chapter_column, location_column, created_column, modified_column, book_fk, asset_column):
        if column and column not in select_columns:
            select_columns.append(column)
    rows = connection.execute(
        f"SELECT {', '.join(_quote_identifier(column) for column in select_columns)} FROM {_quote_identifier(annotation_table)} ORDER BY rowid"
    ).fetchall()
    result: list[dict[str, Any]] = []
    malformed = 0
    for row in rows:
        try:
            raw_quote = row[quote_column]
            if raw_quote is None or (isinstance(raw_quote, str) and not raw_quote.strip()):
                # Apple keeps inactive/tombstone rows in this table.
                continue
            raw_id = None
            for identity_column in identity_columns:
                try:
                    candidate_id = _text(row[identity_column], field="annotation ID")
                except ValueError:
                    continue
                if candidate_id:
                    raw_id = candidate_id
                    break
            if not raw_id:
                raise ValueError("missing annotation ID")
            quote = _text(row[quote_column], field="quote", required=True)
            if not quote:
                raise ValueError("empty quote")
            annotation_id = f"aeannotation:{raw_id}"
            book_title: Optional[str] = None
            author: Optional[str] = None
            if book_table and book_fk:
                fk = _value(row, book_fk)
                if fk is not None:
                    book_row = connection.execute(
                        f"SELECT * FROM {_quote_identifier(book_table)} WHERE {_quote_identifier('Z_PK')} = ? LIMIT 1",
                        (fk,),
                    ).fetchone()
                    if book_row:
                        book_title = _text(book_row[_column(book_columns, "ZTITLE")], field="book title") if _column(book_columns, "ZTITLE") else None
                        author = _author_from_row(book_row, book_columns)
            asset_id = _text(_value(row, asset_column), field="asset ID")
            if asset_id and asset_id in library_books:
                book_title, author = library_books[asset_id]
            result.append(
                {
                    "annotation_id": annotation_id,
                    "quote": quote,
                    "user_note": _text(_value(row, note_column), field="user note"),
                    "book_title": book_title or "",
                    "author": author,
                    "chapter": _text(_value(row, chapter_column), field="chapter"),
                    "location": _text(_value(row, location_column), field="location"),
                    "created_at": _timestamp(_value(row, created_column), field="creation timestamp"),
                    "modified_at": _timestamp(_value(row, modified_column), field="modification timestamp"),
                }
            )
        except (KeyError, ValueError, OverflowError, OSError):
            malformed += 1
    return result, annotation_table, malformed


def read_annotations(config: ReaderConfig) -> dict[str, Any]:
    annotation_path = discover_annotation_database(config)
    if annotation_path is None:
        return _response(
            "unavailable",
            diagnostics=[_diagnostic(
                "APPLE_BOOKS_DATABASE_UNAVAILABLE",
                "Apple Books annotation database was not found.",
                "Open Apple Books or configure apple_books.annotation_database_path, then retry.",
            )],
        )
    library_path = discover_library_database(config, annotation_path)
    annotation_snapshot: Optional[sqlite3.Connection] = None
    library_snapshot: Optional[sqlite3.Connection] = None
    sources: list[SourceMetadata] = []
    try:
        annotation_snapshot, annotation_state = _snapshot(annotation_path, config.snapshot_retries)
        try:
            table = _find_table(annotation_snapshot, ("ZAEANNOTATION", "ZANNOTATION"), "ANNOTATION") or "unknown"
            sources.append(_source_metadata(annotation_path, "annotations", table, annotation_state))
        except sqlite3.DatabaseError:
            pass
        if library_path is not None and library_path.is_file():
            try:
                library_snapshot, library_state = _snapshot(library_path, config.snapshot_retries)
                library_table = _find_table(library_snapshot, ("ZBKLIBRARYASSET",), "BKLIBRARYASSET") or "unknown"
                sources.append(_source_metadata(library_path, "library", library_table, library_state))
            except ReaderFailure:
                library_snapshot = None
        annotations, _table, malformed = _read_annotation_rows(annotation_snapshot, library_snapshot)
        if malformed:
            status = "partial" if annotations else "malformed_rows"
            return _response(
                status,
                annotations,
                diagnostics=[_diagnostic(
                    "APPLE_BOOKS_MALFORMED_ROWS",
                    f"Skipped {malformed} malformed Apple Books annotation row(s).",
                    "Valid annotations remain usable. Retry after Apple Books finishes updating; if the issue persists, report an unsupported schema.",
                    severity="warning",
                )],
                sources=sources,
                skipped_rows=malformed,
            )
        return _response("success", annotations, sources=sources)
    except ReaderFailure as failure:
        return _response(
            failure.status,
            diagnostics=[_diagnostic(failure.code, failure.message, failure.guidance)],
            sources=sources,
        )
    finally:
        if library_snapshot is not None:
            library_snapshot.close()
        if annotation_snapshot is not None:
            annotation_snapshot.close()


def check_access(config: ReaderConfig) -> dict[str, Any]:
    """Return a diagnostic-only access/schema report without returning annotation text."""
    result = read_annotations(config)
    safe = {
        "version": result["version"],
        "status": result["status"],
        "count": result["count"],
        "diagnostics": result["diagnostics"],
    }
    if result.get("skipped_rows"):
        safe["skipped_rows"] = result["skipped_rows"]
    if "sources" in result:
        safe["sources"] = result["sources"]
    return safe


def _failure_response(failure: ReaderFailure) -> dict[str, Any]:
    return _response(
        failure.status,
        diagnostics=[_diagnostic(failure.code, failure.message, failure.guidance)],
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read Apple Books annotations without modifying Apple databases")
    parser.add_argument("--config", type=Path, help="Runtime JSON config containing optional Apple Books path overrides")
    parser.add_argument("--annotation-db", help="Explicit AEAnnotation SQLite path override")
    parser.add_argument("--library-db", help="Explicit BKLibrary SQLite path override")
    parser.add_argument("--preflight", action="store_true", help="Return access/schema diagnostics without annotation text")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = _parser().parse_args(argv)
    try:
        config = load_reader_config(args.config, annotation_db=args.annotation_db, library_db=args.library_db)
        if args.preflight:
            result = check_access(config)
            print(json.dumps(result, ensure_ascii=True, sort_keys=True))
            return EXIT_SUCCESS if result["status"] in {"success", "empty", "partial"} else _status_exit_code(result["status"])
        result = read_annotations(config)
        print(json.dumps(result, ensure_ascii=True, sort_keys=True))
        return _status_exit_code(result["status"])
    except ReaderFailure as failure:
        print(json.dumps(_failure_response(failure), ensure_ascii=True, sort_keys=True))
        return failure.exit_code
    except (OSError, sqlite3.DatabaseError) as exc:
        failure = ReaderFailure(
            "unavailable",
            "APPLE_BOOKS_DATABASE_UNAVAILABLE",
            "Apple Books database could not be read.",
            "Confirm Apple Books access and retry.",
            EXIT_UNAVAILABLE,
        )
        print(json.dumps(_failure_response(failure), ensure_ascii=True, sort_keys=True))
        return failure.exit_code


def _status_exit_code(status: str) -> int:
    return {
        "success": EXIT_SUCCESS,
        "empty": EXIT_SUCCESS,
        "partial": EXIT_SUCCESS,
        "unavailable": EXIT_UNAVAILABLE,
        "permission_denied": EXIT_PERMISSION_DENIED,
        "unsupported_schema": EXIT_UNSUPPORTED_SCHEMA,
        "malformed_rows": EXIT_MALFORMED_ROWS,
        "source_changing": EXIT_SOURCE_CHANGING,
    }.get(status, EXIT_UNAVAILABLE)


if __name__ == "__main__":
    sys.exit(main())
