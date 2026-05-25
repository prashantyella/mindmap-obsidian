import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from mindmap import Note, RuntimeContext, RuntimePaths  # noqa: E402
from mindmap_worker import MindmapWorker  # noqa: E402


class FakeCollection:
    def __init__(self):
        self.deleted = []

    def count(self):
        return 0

    def delete(self, where=None):
        self.deleted.append(where)


def build_context(tmpdir: str) -> RuntimeContext:
    root = Path(tmpdir)
    return RuntimeContext(
        config={
            "chunk_target_tokens": 120,
            "chunk_overlap_tokens": 20,
            "related_limit": 3,
            "related_min_score": 0.0,
        },
        paths=RuntimePaths(
            config_path=root / "config.json",
            vault_root=root,
            db_path=root / ".mindmap" / "chroma",
            state_path=root / ".mindmap" / "state.json",
            log_path=root / ".mindmap" / "run.log",
            preview_path=root / ".mindmap" / "preview.jsonl",
        ),
        embed_settings={"provider": "ollama", "base_url": "http://localhost:11434", "model": "embed"},
        llm_settings={"provider": "ollama", "base_url": "http://localhost:11434", "model": "llm"},
        embed_model="embed",
        llm_model="llm",
        mindmap_heading="## Mindmap",
        write_mindmap_section=False,
        related_strategy="chunk",
        related_candidate_limit=10,
        related_overreach=0,
        related_creative=0,
        related_creative_min=0.45,
        related_creative_max=0.7,
        ollama_embed_timeout=120,
        ollama_llm_timeout=120,
        ollama_retries=0,
        ollama_backoff=0.0,
    )


class MindmapWorkerTests(unittest.TestCase):
    def test_query_related_requires_initialize(self):
        worker = MindmapWorker()

        with self.assertRaisesRegex(RuntimeError, "not initialized"):
            worker.query_related({"path": "A.md"})

    def test_delete_paths_removes_index_and_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            worker = MindmapWorker()
            worker.ctx = build_context(tmpdir)
            worker.chunks = FakeCollection()
            worker.notes_col = FakeCollection()
            worker.state = {"files": {"A.md": {"hash": "old"}}}
            worker.allowed_paths = {"A.md"}

            with patch.object(worker, "refresh_allowed_paths"):
                result = worker.delete_paths({"paths": ["A.md"]})

            self.assertEqual(result["deleted"], 1)
            self.assertNotIn("A.md", worker.state["files"])
            self.assertEqual(worker.chunks.deleted, [{"path": "A.md"}])
            self.assertEqual(worker.notes_col.deleted, [{"path": "A.md"}])

    def test_query_related_can_index_stale_active_note(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            worker = MindmapWorker()
            worker.ctx = build_context(tmpdir)
            worker.chunks = FakeCollection()
            worker.notes_col = FakeCollection()
            worker.state = {"files": {"A.md": {"hash": "old"}}}
            worker.allowed_paths = {"B.md"}
            note = Note(Path(tmpdir) / "A.md", "A.md", "A", "fresh note body")

            with (
                patch("mindmap_worker.load_note_by_relpath", return_value=note),
                patch("mindmap_worker.note_is_indexed", return_value=False),
                patch("mindmap_worker.index_note", return_value={"path": "A.md", "indexed": True, "chunks": 1, "hash": "new"}),
                patch("mindmap_worker.file_signature", return_value="new"),
                patch("mindmap_worker.query_related_for_note", return_value=[{"path": "B.md", "score": 0.8, "kind": "core"}]),
            ):
                result = worker.query_related({"path": "A.md", "ensure_index": True})

            self.assertTrue(result["indexed"])
            self.assertFalse(result["stale"])
            self.assertEqual(result["related"][0]["path"], "B.md")
            self.assertEqual(worker.state["files"]["A.md"]["hash"], "new")


if __name__ == "__main__":
    unittest.main()
