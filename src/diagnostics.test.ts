import test from "node:test";
import assert from "node:assert/strict";

import { buildSpawnFailureResult, formatPreflightNotice, parsePreflightOutput } from "./diagnostics";

test("parsePreflightOutput parses structured JSON output", () => {
  const stdout = `${JSON.stringify({
    ok: false,
    summary: "Preflight failed: model missing",
    config_path: "/vault/.obsidian/plugins/mindmap-obsidian/python/config.json",
    checks: [
      {
        code: "OLLAMA_MODELS_MISSING",
        label: "Ollama models",
        status: "error",
        message: "Required models are missing: llama3.1:8b",
        guidance: "Pull the missing models with ollama pull.",
      },
    ],
  })}\n`;

  const result = parsePreflightOutput(stdout, "", 1);

  assert.equal(result.ok, false);
  assert.equal(result.configPath, "/vault/.obsidian/plugins/mindmap-obsidian/python/config.json");
  assert.equal(result.checks[0]?.code, "OLLAMA_MODELS_MISSING");
  assert.match(formatPreflightNotice(result), /Pull the missing models/);
});

test("buildSpawnFailureResult maps missing executable to actionable guidance", () => {
  const error = Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" as const });
  const result = buildSpawnFailureResult(error, "python3");

  assert.equal(result.ok, false);
  assert.equal(result.checks[0]?.code, "PYTHON_EXECUTABLE_MISSING");
  assert.match(result.summary, /Python executable not found/);
  assert.match(formatPreflightNotice(result), /Install Python/);
});
