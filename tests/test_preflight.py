import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from mindmap import (  # noqa: E402
    build_metadata_messages,
    build_openai_compatible_chat_payload,
    build_omlx_server_command,
    dependency_install_guidance,
    find_missing_models,
    get_embed_settings,
    get_llm_settings,
    should_manage_omlx_server,
    load_config_with_diagnostics,
    parse_llm_metadata_json,
    parse_openai_compatible_chat_response,
)


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

    def test_dependency_install_guidance_uses_installed_plugin_path(self):
        self.assertEqual(
            dependency_install_guidance(),
            "Install dependencies with `python3 -m pip install -r .obsidian/plugins/mindmap-ai/python/requirements.txt`.",
        )

    def test_provider_settings_fall_back_to_legacy_ollama_base_url(self):
        config = {
            "ollama_base_url": "http://localhost:11434",
            "embed_model": "mxbai-embed-large",
            "llm_model": "llama3.1:8b",
        }

        self.assertEqual(
            get_embed_settings(config),
            {
                "provider": "ollama",
                "base_url": "http://localhost:11434",
                "model": "mxbai-embed-large",
            },
        )
        llm_settings = get_llm_settings(config)
        self.assertEqual(llm_settings["provider"], "ollama")
        self.assertEqual(llm_settings["base_url"], "http://localhost:11434")
        self.assertEqual(llm_settings["model"], "llama3.1:8b")
        self.assertEqual(llm_settings["max_tokens"], 1024)

    def test_openai_compatible_payload_includes_json_limits_and_template_kwargs(self):
        messages = build_metadata_messages(
            "A note about deliberate practice.",
            tag_limit=3,
            concept_limit=4,
            controlled_tags=[],
            allow_free_tags=True,
        )

        payload = build_openai_compatible_chat_payload(
            "Qwen3.5-9B-MLX-4bit",
            messages,
            max_tokens=1024,
            chat_template_kwargs={"enable_thinking": False},
        )

        self.assertEqual(payload["model"], "Qwen3.5-9B-MLX-4bit")
        self.assertEqual(payload["max_tokens"], 1024)
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertEqual(payload["chat_template_kwargs"], {"enable_thinking": False})

    def test_openai_compatible_response_content_is_parsed_as_metadata_json(self):
        resp = {
            "choices": [
                {
                    "message": {
                        "content": '{"summary":"Short.","tags":["practice"],"concepts":["deliberate practice"]}'
                    }
                }
            ]
        }

        content = parse_openai_compatible_chat_response(resp)
        metadata = parse_llm_metadata_json(content, "Qwen3.5-9B-MLX-4bit", "openai_compatible")

        self.assertEqual(metadata["summary"], "Short.")
        self.assertEqual(metadata["tags"], ["practice"])
        self.assertEqual(metadata["concepts"], ["deliberate practice"])

    def test_llm_metadata_parser_rejects_non_object_json(self):
        with self.assertRaises(RuntimeError) as ctx:
            parse_llm_metadata_json('["practice"]', "Qwen3.5-9B-MLX-4bit", "openai_compatible")

        self.assertIn("JSON was not an object", str(ctx.exception))

    def test_omlx_auto_manage_detects_local_mlx_openai_provider(self):
        config = {"omlx_auto_manage": "auto"}
        llm_settings = {
            "provider": "openai_compatible",
            "base_url": "http://localhost:8000/v1",
            "model": "Qwen3.5-9B-MLX-4bit",
        }

        self.assertTrue(should_manage_omlx_server(config, llm_settings))

    def test_omlx_auto_manage_skips_remote_openai_provider(self):
        config = {"omlx_auto_manage": "auto"}
        llm_settings = {
            "provider": "openai_compatible",
            "base_url": "https://api.example.com/v1",
            "model": "Qwen3.5-9B-MLX-4bit",
        }

        self.assertFalse(should_manage_omlx_server(config, llm_settings))

    def test_build_omlx_server_command_uses_configured_python_and_base_path(self):
        config = {
            "omlx_python_command": "/tmp/omlx-python",
            "omlx_base_path": "/tmp/omlx-data",
        }
        llm_settings = {
            "base_url": "http://localhost:9000/v1",
        }

        self.assertEqual(
            build_omlx_server_command(config, llm_settings),
            [
                "/tmp/omlx-python",
                "-m",
                "omlx.cli",
                "serve",
                "--base-path",
                "/tmp/omlx-data",
                "--port",
                "9000",
            ],
        )


if __name__ == "__main__":
    unittest.main()
