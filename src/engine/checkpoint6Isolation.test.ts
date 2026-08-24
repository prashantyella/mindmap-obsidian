import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Checkpoint 6 requirement: the new inference services (embedding provider,
 * chunker, metadata pipeline, related selector) must never import
 * `main.ts`, a vault-write seam, an index/vector store, Chroma, a Python
 * subprocess, a remote embedding provider, or otherwise become reachable
 * from production wiring -- they stay pure, provider-neutral services that
 * a future checkpoint composes, never modules that write anything
 * themselves.
 */
const CHECKPOINT_6_FILES = [
  "embeddingProvider.ts",
  "ollamaEmbeddingProvider.ts",
  "chunker.ts",
  "metadataPipeline.ts",
  "localMetadataProvider.ts",
  "relatedSelector.ts",
  "textSimilarity.ts",
  "loopbackEndpoint.ts",
  "identifierValidation.ts",
  "embeddingLimits.ts",
  "controlCharacters.ts",
  "vectorValidation.ts",
];

const FORBIDDEN_IMPORT_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "obsidian runtime", pattern: /from\s+["']obsidian["']/ },
  { label: "main.ts", pattern: /from\s+["'][^"']*main["']/ },
  { label: "atomicStore/vault write seam", pattern: /from\s+["'][^"']*(atomicStore|noteWriter)["']/ },
  { label: "index/vector store", pattern: /from\s+["'][^"']*(vectorStore|cosineIndex|generationStore|overlayStore|indexFs)["']/ },
  { label: "Chroma", pattern: /chroma/i },
  { label: "Python subprocess", pattern: /child_process|execFile|spawn\(/ },
  { label: "node-fetch / raw global fetch reference", pattern: /require\(["']node-fetch["']\)/ },
];

void test("checkpoint 6 inference modules never import main.ts, a vault-write seam, an index store, Chroma, or a subprocess API", () => {
  const engineDir = __dirname;
  for (const fileName of CHECKPOINT_6_FILES) {
    const fullPath = path.join(engineDir, fileName);
    assert.ok(fs.existsSync(fullPath), `expected ${fileName} to exist`);
    const content = fs.readFileSync(fullPath, "utf8");
    for (const { label, pattern } of FORBIDDEN_IMPORT_PATTERNS) {
      assert.doesNotMatch(content, pattern, `${fileName} matched forbidden pattern for "${label}"`);
    }
  }
});

void test("checkpoint 6 inference modules define no second, parallel embedding-provider implementation beyond Ollama", () => {
  const engineDir = __dirname;
  const providerFiles = fs.readdirSync(engineDir).filter((name) => /[Ee]mbeddingProvider\.ts$/.test(name) && !name.endsWith(".test.ts"));
  assert.deepEqual(providerFiles.sort(), ["embeddingProvider.ts", "ollamaEmbeddingProvider.ts"]);
});

void test("metadataPipeline.ts never imports appleAnnotationWikilinks.ts -- Apple-annotation wikilink rendering belongs to NoteWriter alone (review-fix item 1)", () => {
  const content = fs.readFileSync(path.join(__dirname, "metadataPipeline.ts"), "utf8");
  assert.doesNotMatch(content, /appleAnnotationWikilinks/);
  assert.doesNotMatch(content, /isAppleAnnotation/, "metadataPipeline.ts's MetadataOutputV1 builder must be identical for every note kind");
});

void test("embeddingLimits.ts never imports src/index (the constant is a deliberately duplicated mirror, not a re-export)", () => {
  const content = fs.readFileSync(path.join(__dirname, "embeddingLimits.ts"), "utf8");
  assert.doesNotMatch(content, /from\s+["'][^"']*\/index\//);
  assert.doesNotMatch(content, /from\s+["']\.\.\/index/);
});

void test("esbuild's declared entry point does not directly name any checkpoint 6 module (composition happens later, in main.ts)", () => {
  const esbuildConfig = fs.readFileSync(path.join(__dirname, "../..", "esbuild.config.mjs"), "utf8");
  for (const fileName of CHECKPOINT_6_FILES) {
    assert.doesNotMatch(esbuildConfig, new RegExp(fileName.replace(".", "\\.")));
  }
});
