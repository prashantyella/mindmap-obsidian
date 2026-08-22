import test from "node:test";
import assert from "node:assert/strict";

import { resolveLocalModelApiKey } from "./localModelApiKey";

test("local research model key follows Python env-name precedence without exposing the value", () => {
  assert.equal(resolveLocalModelApiKey({ llm_api_key_env: "LOCAL_QWEN_KEY", llm_api_key: "direct" }, { LOCAL_QWEN_KEY: "from-env" }), "from-env");
  assert.equal(resolveLocalModelApiKey({ llm_api_key: "direct" }, {}), "direct");
  assert.equal(resolveLocalModelApiKey({ llm_api_key_env: "MISSING", llm_api_key: "direct" }, {}), "");
});

test("environment variable key value is trimmed before a caller selects an authentication mode on its truthiness", () => {
  const key = resolveLocalModelApiKey({ llm_api_key_env: "LOCAL_QWEN_KEY" }, { LOCAL_QWEN_KEY: "  env-key\n" });
  assert.equal(key, "env-key");

  // A whitespace-only env value must resolve to a falsy empty string, not a
  // truthy whitespace value that would incorrectly select Bearer-auth mode.
  const whitespaceOnly = resolveLocalModelApiKey({ llm_api_key_env: "LOCAL_QWEN_KEY" }, { LOCAL_QWEN_KEY: "   \t  " });
  assert.equal(whitespaceOnly, "");
  assert.equal(Boolean(whitespaceOnly), false);
});
