/** Opt-in real Ollama + real filesystem smoke test; isolated from all vaults. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalizePath, stableNoteIdentity } from "../src/engine/contracts";
import { NodeOwnedFs } from "../src/engine/nodeFs";
import { createWindowSleep, OllamaEmbeddingProvider } from "../src/engine/ollamaEmbeddingProvider";
import { createProductionNoteEmbeddingSeam } from "../src/engine/productionProviderSeams";
import { projectSource } from "../src/engine/sourceProjection";
import { loadCurrentGenerationId, verifyGenerationFully } from "../src/index/generationStore";
import { IndexStore } from "../src/index/indexStore";
import { listOverlayPrefixes, writeUpsertOverlay } from "../src/index/overlayStore";
import { MigrationRunner } from "../src/migration/migrationRunner";
import { MigrationStore } from "../src/migration/migrationStore";
import { DEFAULT_SETTINGS } from "../src/settings";

if (!("window" in globalThis)) Object.defineProperty(globalThis, "window", { value: globalThis });
const bodies = new Map([
  ["Notes/Attention.md", "Protect attention by leaving the phone outside and silencing notifications during a quiet hour of writing."],
  ["Notes/Listening.md", "Listen to a friend without judgment, ask open questions and reflect feelings before preparing a response."],
  ["Notes/Practice.md", "Practice guitar slowly for ten minutes each day, increasing tempo only after accurate repetitions."],
]);

async function main(): Promise<void> {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mindmap-model-migration-"));
  const owned = new NodeOwnedFs(dataRoot);
  await owned.mkdir(`${dataRoot}/migration`);
  await owned.mkdir(`${dataRoot}/overlays`);
  const originalBodies = JSON.stringify([...bodies]);
  const steps: Record<string, unknown>[] = [];
  const makeRunner = (model: string, dimension: number, fail = false): MigrationRunner => {
    const provider = new OllamaEmbeddingProvider({ baseUrl: "http://127.0.0.1:11434", model, maxRetries: 0 }, { fetchImpl: fetch, sleep: createWindowSleep() });
    return new MigrationRunner({
      fs: owned, dataRoot, store: new MigrationStore(owned, dataRoot), embeddingModel: model, dimension, pipelineVersion: 2,
      discovery: { discover: async () => [...bodies].map(([p, text]) => {
        const identity = stableNoteIdentity(canonicalizePath(p));
        return { identity, sourceHash: projectSource(identity, text).sourceHash, embeddingModel: model };
      }) },
      ingestion: {
        sourceReader: { read: async (identity) => ({ identity, rawContent: bodies.get(identity.canonicalPath)! }) },
        embedding: fail ? { embed: async () => { throw new Error("injected provider failure"); } } : createProductionNoteEmbeddingSeam(provider, model, { targetTokens: DEFAULT_SETTINGS.chunkTargetTokens, overlapTokens: DEFAULT_SETTINGS.chunkOverlapTokens }),
      },
    });
  };
  const finish = async (runner: MigrationRunner): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      const status = await runner.reconcile();
      if (status.phase === "complete" || status.phase === "failed") {
        steps.push({ ...status, generationId: await loadCurrentGenerationId(owned, dataRoot) });
        return;
      }
    }
    throw new Error("migration did not settle within 100 ticks");
  };
  const old = makeRunner("mxbai-embed-large:latest", 1024);
  await old.start();
  await finish(old);
  assert.equal((await old.getStatus()).phase, "complete");
  const oldId = await loadCurrentGenerationId(owned, dataRoot);
  const first = (await verifyGenerationFully(owned, dataRoot, oldId!)).noteMetadata[0];
  const identity = first.identity;
  // Create a genuine old-model overlay that must not shadow the replacement.
  const vector = new Float32Array(1024); vector[0] = 1;
  await writeUpsertOverlay(owned, dataRoot, { identity, sourceHash: first.sourceHash, embeddingModel: "mxbai-embed-large:latest", dimension: 1024, noteVector: vector, chunkVectors: [] });
  const next = makeRunner("embeddinggemma-2:270m", 768);
  assert.notEqual((await next.reconcile()).phase, "complete");
  await next.reconcile(); // Stage one note, then construct a fresh runner (reload).
  assert.equal(await loadCurrentGenerationId(owned, dataRoot), oldId);
  const resumed = makeRunner("embeddinggemma-2:270m", 768);
  await finish(resumed);
  assert.equal((await resumed.getStatus()).phase, "complete");
  const gemmaId = await loadCurrentGenerationId(owned, dataRoot);
  assert.notEqual(gemmaId, oldId);
  assert.equal((await listOverlayPrefixes(owned, dataRoot)).records.length, 0);
  assert.equal((await verifyGenerationFully(owned, dataRoot, gemmaId!)).manifest.dimension, 768);
  await assert.rejects(new IndexStore(owned, dataRoot).queryRelated({ embeddingModel: "another-768d-model", queryVector: Float32Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0), queryChunkVectors: [], limit: 8 }));
  const failed = makeRunner("failure-model", 768, true);
  await failed.reconcile(); await finish(failed);
  assert.equal((await failed.getStatus()).phase, "failed");
  assert.equal(await loadCurrentGenerationId(owned, dataRoot), gemmaId);
  const restored = makeRunner("mxbai-embed-large:latest", 1024);
  await restored.start(); await finish(restored);
  assert.equal((await restored.getStatus()).phase, "complete");
  assert.equal(JSON.stringify([...bodies]), originalBodies);
  await verifyGenerationFully(owned, dataRoot, oldId!);
  process.stdout.write(JSON.stringify({ passed: true, dataRoot, steps, checks: ["actual Ollama vectors and NodeOwnedFs", "model and dimension cutover", "old pointer retained during staging", "reload resumes staged work", "old overlays retired", "same-dimension wrong-model query rejected", "provider failure retains active generation", "switch back to mxbai", "source text unchanged", "original generation still verifies"] }, null, 2) + "\n");
}
void main();
