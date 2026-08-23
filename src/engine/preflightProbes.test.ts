import test from "node:test";
import assert from "node:assert/strict";

import {
  createAppleBooksReadinessProbe,
  createBackgroundSchedulerReadinessProbe,
  createLocalMetadataReadinessProbe,
  createOllamaEmbeddingReadinessProbe,
  createResearchCredentialReadinessProbe,
} from "./preflightProbes";

function abortSignal(): AbortSignal {
  return new AbortController().signal;
}

void test("Ollama embedding readiness probe: reports ok with the response dimension on a successful bounded embed", async () => {
  const probe = createOllamaEmbeddingReadinessProbe(
    { embedBatch: async (request) => ({ model: request.model, dimension: 4, items: request.items.map((item) => ({ id: item.id, values: [0.5, 0.5, 0.5, 0.5] })) }) },
    { model: "nomic-embed-text", expectedDimension: 4 },
  );
  const outcome = await probe(abortSignal());
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.context?.dimension, 4);
});

void test("Ollama embedding readiness probe: degrades (not fails) on a dimension mismatch, never echoing the vector values", async () => {
  const probe = createOllamaEmbeddingReadinessProbe(
    { embedBatch: async (request) => ({ model: request.model, dimension: 768, items: request.items.map((item) => ({ id: item.id, values: [1] })) }) },
    { model: "nomic-embed-text", expectedDimension: 4 },
  );
  const outcome = await probe(abortSignal());
  assert.equal(outcome.status, "degraded");
  assert.equal(outcome.context?.dimension, 768);
  assert.equal(JSON.stringify(outcome).includes("0.5"), false);
});

void test("Ollama embedding readiness probe: a thrown provider error becomes a static unavailable result, never the raw message", async () => {
  const probe = createOllamaEmbeddingReadinessProbe(
    { embedBatch: async () => { throw new Error("connection refused to 127.0.0.1:11434 -- secret-looking-detail"); } },
    { model: "nomic-embed-text" },
  );
  const outcome = await probe(abortSignal());
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.message.includes("secret-looking-detail"), false);
  assert.equal(JSON.stringify(outcome).includes("secret-looking-detail"), false);
});

void test("local metadata readiness probe: reports ok on non-blank content, never forwarding the content itself", async () => {
  const probe = createLocalMetadataReadinessProbe({ complete: async () => "ready" }, "llama3");
  const outcome = await probe(abortSignal());
  assert.equal(outcome.status, "ok");
  assert.equal(JSON.stringify(outcome).includes("ready"), false);
});

void test("local metadata readiness probe: blank content is unavailable", async () => {
  const probe = createLocalMetadataReadinessProbe({ complete: async () => "   " }, "llama3");
  const outcome = await probe(abortSignal());
  assert.equal(outcome.status, "unavailable");
});

void test("local metadata readiness probe: a thrown error becomes a static unavailable result", async () => {
  const probe = createLocalMetadataReadinessProbe({ complete: async () => { throw new Error("raw provider body leak attempt"); } }, "llama3");
  const outcome = await probe(abortSignal());
  assert.equal(outcome.status, "unavailable");
  assert.equal(JSON.stringify(outcome).includes("raw provider body"), false);
});

void test("Apple Books readiness probe: success status maps to ok and only the closed status enum reaches context", async () => {
  const probe = createAppleBooksReadinessProbe({
    checkAccess: async () => ({ version: 1, status: "success", diagnostics: [], count: 3, sources: [{ path: "/Users/secret/Library/db.sqlite" } as never] }),
  });
  const outcome = await probe(abortSignal());
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.context?.readStatus, "success");
  assert.equal(JSON.stringify(outcome).includes("secret"), false);
});

void test("Apple Books readiness probe: empty/partial statuses degrade rather than fail", async () => {
  const probe = createAppleBooksReadinessProbe({ checkAccess: async () => ({ version: 1, status: "empty", diagnostics: [], count: 0 }) });
  const outcome = await probe(abortSignal());
  assert.equal(outcome.status, "degraded");
});

void test("Apple Books readiness probe: permission_denied maps to unavailable without leaking diagnostics", async () => {
  const probe = createAppleBooksReadinessProbe({
    checkAccess: async () => ({ version: 1, status: "permission_denied", diagnostics: [{ severity: "error", code: "X", message: "/Users/real/name/Library", guidance: "g" }], count: 0 }),
  });
  const outcome = await probe(abortSignal());
  assert.equal(outcome.status, "unavailable");
  assert.equal(JSON.stringify(outcome).includes("/Users/real/name"), false);
});

void test("Apple Books readiness probe: a thrown error becomes a static unavailable result", async () => {
  const probe = createAppleBooksReadinessProbe({ checkAccess: async () => { throw new Error("/Users/real/path leaked"); } });
  const outcome = await probe(abortSignal());
  assert.equal(outcome.status, "unavailable");
  assert.equal(JSON.stringify(outcome).includes("/Users/real/path"), false);
});

void test("research credential readiness probe: present -> ok, absent -> degraded (not unavailable, since it's an optional capability)", async () => {
  const present = createResearchCredentialReadinessProbe(async () => true);
  assert.equal((await present(abortSignal())).status, "ok");
  const absent = createResearchCredentialReadinessProbe(async () => false);
  assert.equal((await absent(abortSignal())).status, "degraded");
});

void test("research credential readiness probe: never returns or logs the credential value -- the injected function is boolean-only by type", async () => {
  let sawSecret = false;
  const hasCredential = async (): Promise<boolean> => {
    const secretLookingValue = "sk-not-a-real-secret";
    sawSecret = secretLookingValue.length > 0;
    return true;
  };
  const probe = createResearchCredentialReadinessProbe(hasCredential);
  const outcome = await probe(abortSignal());
  assert.equal(sawSecret, true);
  assert.equal(JSON.stringify(outcome).includes("sk-not-a-real-secret"), false);
});

void test("research credential readiness probe: a throwing check degrades rather than propagating", async () => {
  const probe = createResearchCredentialReadinessProbe(async () => { throw new Error("keychain access denied"); });
  const outcome = await probe(abortSignal());
  assert.equal(outcome.status, "degraded");
});

void test("background scheduler readiness probe: installed -> ok, removed -> degraded, foreign-conflict -> unavailable", async () => {
  assert.equal((await createBackgroundSchedulerReadinessProbe({ status: async () => "installed" })(abortSignal())).status, "ok");
  assert.equal((await createBackgroundSchedulerReadinessProbe({ status: async () => "removed" })(abortSignal())).status, "degraded");
  assert.equal((await createBackgroundSchedulerReadinessProbe({ status: async () => "foreign-conflict" })(abortSignal())).status, "unavailable");
});

void test("background scheduler readiness probe: unsupported-platform is ok, not a failure", async () => {
  const outcome = await createBackgroundSchedulerReadinessProbe({ status: async () => "unsupported-platform" })(abortSignal());
  assert.equal(outcome.status, "ok");
});

void test("background scheduler readiness probe never calls reconcile/remove -- only status() exists on the narrowed seam type", async () => {
  let statusCalls = 0;
  const seam = { status: async () => { statusCalls += 1; return "installed" as const; } };
  await createBackgroundSchedulerReadinessProbe(seam)(abortSignal());
  assert.equal(statusCalls, 1);
  assert.deepEqual(Object.keys(seam), ["status"]);
});
