import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from mindmap import (  # noqa: E402
    build_metadata_messages,
    build_openai_compatible_chat_payload,
    build_omlx_server_command,
    classify_provider_error,
    dependency_install_guidance,
    find_missing_models,
    get_embed_settings,
    get_llm_settings,
    should_manage_omlx_server,
    load_config_with_diagnostics,
    parse_llm_metadata_json,
    parse_openai_compatible_chat_response,
    run_preflight,
    start_managed_omlx_server,
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

    def test_classifies_connection_refused(self):
        details = classify_provider_error(URLError(ConnectionRefusedError("connection refused")))

        self.assertEqual(details["code"], "PROVIDER_CONNECTION_REFUSED")
        self.assertEqual(details["category"], "connection_refused")

    def test_classifies_unexpected_http_service_and_auth_failure(self):
        not_provider = classify_provider_error(HTTPError("http://localhost:8000/models", 404, "Not Found", {}, None))
        unauthorized = classify_provider_error(HTTPError("https://api.example.com/models", 401, "Unauthorized", {}, None))

        self.assertEqual(not_provider["code"], "PROVIDER_UNEXPECTED_SERVICE")
        self.assertEqual(unauthorized["code"], "PROVIDER_AUTH_FAILED")

    def test_preflight_reports_missing_model(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "embed_provider": "ollama",
                        "embed_base_url": "http://localhost:11434",
                        "embed_model": "embed",
                        "llm_provider": "ollama",
                        "llm_base_url": "http://localhost:11434",
                        "llm_model": "missing",
                    }
                ),
                encoding="utf-8",
            )
            with patch("mindmap.fetch_ollama_models", return_value=["embed"]):
                result = run_preflight(config_path)

        checks = {check["code"]: check for check in result["checks"]}
        self.assertIn("LLM_MODELS_MISSING", checks)
        self.assertFalse(result["ok"])

    def test_preflight_stops_only_server_started_for_probe(self):
        fake_process = object()
        config = {
            "embed_provider": "ollama",
            "embed_base_url": "http://localhost:11434",
            "embed_model": "embed",
            "llm_provider": "openai_compatible",
            "llm_base_url": "http://localhost:8000/v1",
            "llm_model": "Qwen3.5-9B-MLX-4bit",
            "omlx_auto_manage": True,
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "config.json"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            with patch("mindmap.fetch_ollama_models", return_value=["embed"]), \
                    patch("mindmap.fetch_openai_compatible_models", return_value=["Qwen3.5-9B-MLX-4bit"]), \
                    patch("mindmap.start_managed_omlx_server", return_value=fake_process) as start, \
                    patch("mindmap.stop_managed_omlx_server") as stop:
                result = run_preflight(config_path)

        self.assertTrue(result["ok"])
        start.assert_called_once()
        stop.assert_called_once()
        self.assertIs(stop.call_args.args[0], fake_process)

    def test_managed_omlx_does_not_start_over_auth_failure(self):
        config = {"omlx_auto_manage": True, "omlx_python_command": "/tmp/omlx-python"}
        settings = {
            "provider": "openai_compatible",
            "base_url": "http://localhost:8000/v1",
            "model": "Qwen3.5-9B-MLX-4bit",
            "api_key": "bad-key",
        }
        auth_error = HTTPError(settings["base_url"] + "/models", 401, "Unauthorized", {}, None)
        with patch("mindmap.fetch_openai_compatible_models", side_effect=auth_error), \
                patch("mindmap.subprocess.Popen") as popen:
            process = start_managed_omlx_server(config, settings, lambda _message: None)

        self.assertIsNone(process)
        popen.assert_not_called()

    def test_managed_omlx_ignores_stale_bind_conflict_log_lines(self):
        settings = {
            "provider": "openai_compatible",
            "base_url": "http://localhost:8000/v1",
            "model": "Qwen3.5-9B-MLX-4bit",
            "api_key": "",
        }
        process = type("ExitedProcess", (), {"poll": lambda _self: 1, "returncode": 1})()
        with tempfile.TemporaryDirectory() as tmpdir:
            log_dir = Path(tmpdir) / "logs"
            log_dir.mkdir()
            (log_dir / "mindmap-omlx-server.log").write_text(
                "old run: address already in use\n",
                encoding="utf-8",
            )
            config = {
                "omlx_auto_manage": True,
                "omlx_base_path": tmpdir,
                "omlx_server_command": ["omlx-test"],
            }
            connection_error = URLError(ConnectionRefusedError("connection refused"))
            with patch("mindmap.fetch_openai_compatible_models", side_effect=connection_error), \
                    patch("mindmap.subprocess.Popen", return_value=process):
                with self.assertRaises(RuntimeError) as ctx:
                    start_managed_omlx_server(config, settings, lambda _message: None)

        self.assertIn("[OMLX_START_FAILED]", str(ctx.exception))
        self.assertNotIn("[OMLX_PORT_CONFLICT]", str(ctx.exception))

    def test_preflight_reports_managed_omlx_port_conflict_without_stopping_process(self):
        config = {
            "embed_provider": "ollama",
            "embed_base_url": "http://localhost:11434",
            "embed_model": "embed",
            "llm_provider": "openai_compatible",
            "llm_base_url": "http://localhost:8000/v1",
            "llm_model": "Qwen3.5-9B-MLX-4bit",
            "omlx_auto_manage": True,
        }
        conflict = RuntimeError(
            "[error][OMLX_PORT_CONFLICT] Managed oMLX could not bind port 8000 because it is already occupied."
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            config_path = Path(tmpdir) / "config.json"
            config_path.write_text(json.dumps(config), encoding="utf-8")
            with patch("mindmap.fetch_ollama_models", return_value=["embed"]), \
                    patch("mindmap.start_managed_omlx_server", side_effect=conflict), \
                    patch("mindmap.stop_managed_omlx_server") as stop:
                result = run_preflight(config_path)

        checks = {check["code"]: check for check in result["checks"]}
        self.assertIn("OMLX_PORT_CONFLICT", checks)
        self.assertIn("will not terminate unrelated processes", checks["OMLX_PORT_CONFLICT"]["guidance"])
        stop.assert_not_called()


if __name__ == "__main__":
    unittest.main()
