import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))

from mindmap import resolve_llm_api_key, resolve_remove_mindmap_section  # noqa: E402


class RemoveMindmapSectionStrictnessTests(unittest.TestCase):
    def test_accepts_only_the_literal_boolean_true(self):
        self.assertTrue(resolve_remove_mindmap_section({"remove_mindmap_section": True}))

    def test_rejects_truthy_non_boolean_values(self):
        for value in ("true", "false", "yes", "1", 1, 1.0, ["true"], {"enabled": True}):
            with self.subTest(value=value):
                self.assertFalse(resolve_remove_mindmap_section({"remove_mindmap_section": value}))

    def test_rejects_falsy_and_missing_values(self):
        for value in (False, None, "", 0, []):
            with self.subTest(value=value):
                self.assertFalse(resolve_remove_mindmap_section({"remove_mindmap_section": value}))
        self.assertFalse(resolve_remove_mindmap_section({}))


class ApiKeyTrimmedBeforeAuthModeSelectionTests(unittest.TestCase):
    def test_direct_config_key_is_trimmed(self):
        self.assertEqual(resolve_llm_api_key({"llm_api_key": "  direct-key  "}), "direct-key")

    def test_environment_variable_value_is_trimmed(self):
        with patch.dict("os.environ", {"LOCAL_QWEN_KEY": "  env-key\n"}, clear=False):
            self.assertEqual(
                resolve_llm_api_key({"llm_api_key_env": "LOCAL_QWEN_KEY", "llm_api_key": "direct"}),
                "env-key",
            )

    def test_whitespace_only_environment_value_resolves_to_falsy_empty_string(self):
        # A caller selects Bearer-auth mode on `if api_key:` truthiness; an
        # untrimmed whitespace-only env value would incorrectly read as
        # "present" and select Bearer mode with a garbage token.
        with patch.dict("os.environ", {"LOCAL_QWEN_KEY": "   \t  "}, clear=False):
            key = resolve_llm_api_key({"llm_api_key_env": "LOCAL_QWEN_KEY", "llm_api_key": "direct"})
            self.assertEqual(key, "")
            self.assertFalse(key)

    def test_missing_environment_variable_falls_back_to_empty_string(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(
                resolve_llm_api_key({"llm_api_key_env": "MISSING_KEY", "llm_api_key": "direct"}),
                "",
            )


if __name__ == "__main__":
    unittest.main()
