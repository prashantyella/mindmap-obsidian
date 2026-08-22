import test from "node:test";
import assert from "node:assert/strict";

import { MindmapSemanticEnvironment } from "./semanticEnvironment";
import type { ResolvedRuntime } from "./pathResolver";
import type { LiveRelatedResponse, LookupRelatedResponse, SemanticHealth } from "./semanticTypes";

const health: SemanticHealth = {
  ready: true,
  scope: "current",
  config_path: "/vault/config.json",
  vault_root: "/vault",
  db_path: "/vault/db",
  embed_model: "test-embed",
  llm_model: "test-llm",
  allowed_paths: 1,
  indexed_notes: 12,
  indexed_chunks: 34,
};

const validRuntime: ResolvedRuntime = {
  command: { command: "python3", args: [], cwd: "/vault" },
  scriptPath: "/vault/.obsidian/plugins/mindmap-ai/python/mindmap.py",
  configPath: "/vault/.obsidian/plugins/mindmap-ai/python/config.json",
  usedDefaults: {
    pythonCommand: true,
    scriptPath: true,
    configPath: true,
  },
  messages: [],
  trust: {
    level: "trusted",
    interpreter: "python3",
    script: "bundled",
    config: "bundled",
    reasons: [],
  },
  valid: true,
};

function response(pathValue: string): LiveRelatedResponse {
  return {
    path: pathValue,
    hash: "hash",
    indexed: true,
    stale: false,
    index_result: null,
    related: [],
  };
}

class FakeSemanticClient {
  started = false;
  shutdowns = 0;

  constructor(private readonly query: () => Promise<LiveRelatedResponse>) {}

  async start(): Promise<SemanticHealth> {
    this.started = true;
    return health;
  }

  async queryRelated(): Promise<LiveRelatedResponse> {
    return this.query();
  }

  async queryText(): Promise<LookupRelatedResponse> {
    return {
      query: "test",
      related: [],
    };
  }

  async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }
}

void test("semantic environment retries one query after a worker failure", async () => {
  const clients: FakeSemanticClient[] = [];
  const logs: string[] = [];
  let queryCount = 0;
  const environment = new MindmapSemanticEnvironment(
    () => validRuntime,
    (message) => logs.push(message),
    () => undefined,
    () => {
      const client = new FakeSemanticClient(async () => {
        queryCount += 1;
        if (queryCount === 1) {
          throw new Error("worker exited");
        }
        return response("Active.md");
      });
      clients.push(client);
      return client;
    },
  );

  const result = await environment.queryRelated("Active.md", true);

  assert.equal(result.path, "Active.md");
  assert.equal(queryCount, 2);
  assert.equal(clients.length, 2);
  assert.equal(clients[0]?.shutdowns, 1);
  assert.equal(environment.getStatus().state, "ready");
  assert(logs.some((message) => message.includes("worker exited")));
});

void test("semantic environment marks unexpected worker exits as degraded", async () => {
  let exitHandler: ((error: Error) => void) | undefined;
  const environment = new MindmapSemanticEnvironment(
    () => validRuntime,
    () => undefined,
    () => undefined,
    (options) => {
      exitHandler = options.onExit;
      return new FakeSemanticClient(async () => response("Active.md"));
    },
  );

  await environment.start("current");
  exitHandler?.(new Error("worker died"));

  const status = environment.getStatus();
  assert.equal(status.state, "degraded");
  assert.equal(status.message, "worker died");
});
