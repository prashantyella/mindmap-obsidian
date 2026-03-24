import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from mindmap import find_missing_models, load_config_with_diagnostics  # noqa: E402


class PreflightHelperTests(unittest.TestCase):
    def test_find_missing_models_accepts_available_latest_tag_for_base_name(self):
        missing = find_missing_models(
            ["mxbai-embed-large", "llama3.1:8b"],
            ["mxbai-embed-large:latest", "llama3.1:8b", "nomic-embed-text"],
        )

        self.assertEqual(missing, [])

    def test_load_config_with_diagnostics_flags_invalid_json(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "config.json"
            config_path.write_text('{"vault_root": ', encoding="utf-8")

            config, check = load_config_with_diagnostics(config_path)

        self.assertIsNone(config)
        self.assertEqual(check["code"], "CONFIG_INVALID")
        self.assertIn("invalid JSON", check["message"])

    def test_load_config_with_diagnostics_accepts_valid_object(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "config.json"
            config_path.write_text(json.dumps({"vault_root": ".", "ollama_base_url": "http://localhost:11434"}), encoding="utf-8")

            config, check = load_config_with_diagnostics(config_path)

        self.assertEqual(config["vault_root"], ".")
        self.assertEqual(check["code"], "CONFIG_OK")


if __name__ == "__main__":
    unittest.main()
