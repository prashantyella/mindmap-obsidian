"""Deterministic SQLite fixtures for the read-only Apple Books reader tests."""

from __future__ import annotations

import sqlite3
from pathlib import Path


def build_fixture(root: Path, shape: str = "joined", *, malformed: bool = False, partial: bool = False) -> tuple[Path, Path]:
    root.mkdir(parents=True, exist_ok=True)
    annotation_path = root / "AEAnnotation.sqlite"
    library_path = root / "BKLibrary.sqlite"

    annotation = sqlite3.connect(annotation_path)
    try:
        if shape == "joined":
            annotation.executescript(
                """
                CREATE TABLE ZAEBOOK (Z_PK INTEGER PRIMARY KEY, ZTITLE TEXT, ZAUTHOR TEXT);
                CREATE TABLE ZAEANNOTATION (
                    Z_PK INTEGER PRIMARY KEY,
                    ZANNOTATIONUUID TEXT,
                    ZANNOTATIONSELECTEDTEXT TEXT,
                    ZANNOTATIONNOTE TEXT,
                    ZANNOTATIONCHAPTER TEXT,
                    ZANNOTATIONLOCATION TEXT,
                    ZCREATIONDATE REAL,
                    ZMODIFICATIONDATE REAL,
                    ZANNOTATIONBOOK INTEGER
                );
                INSERT INTO ZAEBOOK VALUES (7, 'The Quiet Book', 'A. Reader');
                """
            )
            annotation.execute(
                "INSERT INTO ZAEANNOTATION VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (1, "uuid-1", b"bad" if malformed else "A useful highlighted passage.", "A personal note.", "Chapter One", "42", 100000000.0, 100000100.0, 7),
            )
            annotation.execute(
                "INSERT INTO ZAEANNOTATION VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (2, "uuid-tombstone", "", None, None, None, None, None, 7),
            )
            if partial:
                annotation.execute(
                    "INSERT INTO ZAEANNOTATION VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (3, "uuid-malformed", b"bad-row", None, None, None, None, None, 7),
                )
        elif shape == "asset-enriched":
            annotation.executescript(
                """
                CREATE TABLE ZANNOTATION (
                    Z_PK INTEGER PRIMARY KEY,
                    ZANNOTATIONSELECTEDTEXT TEXT,
                    ZANNOTATIONNOTE TEXT,
                    ZFUTUREPROOFING5 TEXT,
                    ZPLLOCATIONRANGESTART INTEGER,
                    ZANNOTATIONCREATIONDATE REAL,
                    ZANNOTATIONMODIFICATIONDATE REAL,
                    ZANNOTATIONASSETID TEXT
                );
                """
            )
            annotation.execute(
                "INSERT INTO ZANNOTATION VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (10, "A second schema passage.", None, "Part II", 88, 200000000.0, 200000010.0, "asset-10"),
            )
        elif shape == "unsupported":
            annotation.execute("CREATE TABLE ZNOT_APPLE (id INTEGER PRIMARY KEY)")
        else:
            raise ValueError(f"unknown fixture shape: {shape}")
        annotation.commit()
    finally:
        annotation.close()

    if shape == "asset-enriched":
        library = sqlite3.connect(library_path)
        try:
            library.executescript(
                """
                CREATE TABLE ZBKLIBRARYASSET (
                    Z_PK INTEGER PRIMARY KEY,
                    ZASSETID TEXT,
                    ZTITLE TEXT,
                    ZAUTHORFAMILYNAME TEXT,
                    ZAUTHORGIVENNAME TEXT
                );
                INSERT INTO ZBKLIBRARYASSET VALUES (1, 'asset-10', 'The Other Book', 'Writer', 'B.');
                """
            )
            library.commit()
        finally:
            library.close()

    return annotation_path, library_path
