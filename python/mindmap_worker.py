#!/usr/bin/env python3
"""Resident JSON-lines worker for Mindmap semantic lookup and warm indexing."""

import json
import sys
import traceback
from pathlib import Path
from typing import Dict, List, Optional

from mindmap import (
    RuntimeContext,
    delete_note_from_index,
    file_signature,
    index_note,
    list_notes,
    list_notes_from_relpaths,
    load_json,
    load_note_by_relpath,
    load_runtime_context,
    note_is_indexed,
    open_collections,
    query_related_for_note,
    query_related_for_text,
    resolve_config_path,
    resolve_notes_paths,
    save_json,
)


class MindmapWorker:
    def __init__(self):
        self.ctx: Optional[RuntimeContext] = None
        self.client = None
        self.chunks = None
        self.notes_col = None
        self.state: Dict = {"files": {}}
        self.allowed_paths = set()
        self.scope = "default"

    def log(self, line: str):
        print(line, file=sys.stderr, flush=True)

    def initialize(self, params: Dict) -> Dict:
        config_path = resolve_config_path(params.get("config"))
        self.scope = str(params.get("scope", "default"))
        self.ctx = load_runtime_context(config_path)
        self.client, self.chunks, self.notes_col = open_collections(self.ctx.paths.db_path, rebuild=False)
        self.state = load_json(self.ctx.paths.state_path, {"files": {}})
        if not isinstance(self.state, dict):
            self.state = {"files": {}}
        if not isinstance(self.state.get("files"), dict):
            self.state["files"] = {}
        self.refresh_allowed_paths()
        return self.health({})

    def refresh_allowed_paths(self):
        self.require_initialized()
        notes_paths = resolve_notes_paths(self.ctx.config, self.scope)
        notes = list_notes(
            self.ctx.paths.vault_root,
            notes_paths,
            self.ctx.config.get("min_note_words", 30),
            self.ctx.mindmap_heading,
        )
        self.allowed_paths = {note.relpath for note in notes}

    def require_initialized(self):
        if self.ctx is None or self.chunks is None or self.notes_col is None:
            raise RuntimeError("Worker is not initialized. Call initialize first.")

    def health(self, _params: Dict) -> Dict:
        self.require_initialized()
        return {
            "ready": True,
            "scope": self.scope,
            "config_path": str(self.ctx.paths.config_path),
            "vault_root": str(self.ctx.paths.vault_root),
            "db_path": str(self.ctx.paths.db_path),
            "embed_model": self.ctx.embed_model,
            "llm_model": self.ctx.llm_model,
            "allowed_paths": len(self.allowed_paths),
            "indexed_notes": self.notes_col.count(),
            "indexed_chunks": self.chunks.count(),
        }

    def index_paths(self, params: Dict) -> Dict:
        self.require_initialized()
        paths = self.normalize_paths(params.get("paths"))
        min_words = int(params.get("min_words", self.ctx.config.get("min_note_words", 30)))
        notes = list_notes_from_relpaths(self.ctx.paths.vault_root, paths, min_words, self.ctx.mindmap_heading)
        results = []
        for note in notes:
            result = index_note(note, self.chunks, self.notes_col, self.ctx, log_fn=self.log)
            if result.get("indexed"):
                self.state["files"][note.relpath] = {"hash": result["hash"]}
            results.append(result)
        save_json(self.ctx.paths.state_path, self.state)
        self.refresh_allowed_paths()
        return {"indexed": sum(1 for result in results if result.get("indexed")), "results": results}

    def delete_paths(self, params: Dict) -> Dict:
        self.require_initialized()
        paths = self.normalize_paths(params.get("paths"))
        results = [
            delete_note_from_index(path, self.chunks, self.notes_col, self.state["files"])
            for path in paths
        ]
        save_json(self.ctx.paths.state_path, self.state)
        self.refresh_allowed_paths()
        return {"deleted": len(results), "results": results}

    def query_related(self, params: Dict) -> Dict:
        self.require_initialized()
        relpath = params.get("path")
        if not isinstance(relpath, str) or not relpath.strip():
            raise RuntimeError("query_related requires params.path")

        note = load_note_by_relpath(self.ctx.paths.vault_root, relpath, self.ctx.mindmap_heading, min_words=0)
        content_hash = file_signature(note.body)
        previous_hash = self.state["files"].get(note.relpath, {}).get("hash")
        stale = previous_hash != content_hash
        indexed = note_is_indexed(self.notes_col, note.relpath)
        ensure_index = bool(params.get("ensure_index", False))

        index_result = None
        if ensure_index and (stale or not indexed):
            index_result = index_note(note, self.chunks, self.notes_col, self.ctx, log_fn=self.log)
            indexed = bool(index_result.get("indexed"))
            if indexed:
                persisted_hash = str(index_result.get("hash", content_hash))
                self.state["files"][note.relpath] = {"hash": persisted_hash}
                save_json(self.ctx.paths.state_path, self.state)
                stale = False

        related = []
        if indexed:
            related = query_related_for_note(note, self.chunks, self.notes_col, self.ctx, self.allowed_paths, log_fn=self.log)

        return {
            "path": note.relpath,
            "hash": content_hash,
            "indexed": indexed,
            "stale": stale,
            "index_result": index_result,
            "related": related,
        }

    def query_text(self, params: Dict) -> Dict:
        self.require_initialized()
        query = params.get("query")
        if not isinstance(query, str) or not query.strip():
            raise RuntimeError("query_text requires params.query")
        limit = params.get("limit")
        if limit is not None:
            try:
                limit = int(limit)
            except (TypeError, ValueError):
                raise RuntimeError("query_text params.limit must be a number") from None

        related = query_related_for_text(
            query,
            self.chunks,
            self.notes_col,
            self.ctx,
            self.allowed_paths,
            limit=limit,
            log_fn=self.log,
        )
        return {
            "query": query.strip(),
            "related": related,
        }

    def refresh_config(self, params: Dict) -> Dict:
        return self.initialize(params)

    def shutdown(self, _params: Dict) -> Dict:
        return {"shutdown": True}

    @staticmethod
    def normalize_paths(value) -> List[str]:
        if not isinstance(value, list):
            raise RuntimeError("paths must be an array")
        return [str(path).strip() for path in value if str(path).strip()]


def write_message(payload: Dict):
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def main() -> int:
    worker = MindmapWorker()
    methods = {
        "initialize": worker.initialize,
        "health": worker.health,
        "index_paths": worker.index_paths,
        "delete_paths": worker.delete_paths,
        "query_related": worker.query_related,
        "query_text": worker.query_text,
        "refresh_config": worker.refresh_config,
        "shutdown": worker.shutdown,
    }

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            method_name = request.get("method")
            params = request.get("params") or {}
            if method_name not in methods:
                raise RuntimeError(f"Unknown worker method: {method_name}")
            result = methods[method_name](params)
            write_message({"id": request_id, "ok": True, "result": result})
            if method_name == "shutdown":
                return 0
        except Exception as exc:
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            write_message({"id": request_id, "ok": False, "error": str(exc)})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
