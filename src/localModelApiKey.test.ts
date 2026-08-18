import test from "node:test";
import assert from "node:assert/strict";

import { resolveLocalModelApiKey } from "./localModelApiKey";

test("local research model key follows Python env-name precedence without exposing the value", () => {
  assert.equal(resolveLocalModelApiKey({ llm_api_key_env: "LOCAL_QWEN_KEY", llm_api_key: "direct" }, { LOCAL_QWEN_KEY: "from-env" }), "from-env");
  assert.equal(resolveLocalModelApiKey({ llm_api_key: "direct" }, {}), "direct");
  assert.equal(resolveLocalModelApiKey({ llm_api_key_env: "MISSING", llm_api_key: "direct" }, {}), "");
});
