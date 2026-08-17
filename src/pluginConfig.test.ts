import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_METADATA_MODEL, getLlmProviderConfigStatus } from "./pluginConfig";

void test("provider fallback uses the approved Qwen metadata model", () => {
  const status = getLlmProviderConfigStatus({
    valid: false,
    messages: [],
  } as never, false);

  assert.equal(DEFAULT_METADATA_MODEL, "Qwen3.5-9B-MLX-4bit");
  assert.equal(status.model, DEFAULT_METADATA_MODEL);
});
