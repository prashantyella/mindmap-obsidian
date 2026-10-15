import fs from "node:fs";
import path from "node:path";

import { canonicalizePath, stableNoteIdentity } from "../src/engine/contracts";
import { chunkText, DEFAULT_OVERLAP_TOKENS, DEFAULT_TARGET_TOKENS } from "../src/engine/chunker";
import { createOllamaMetadataProvider } from "../src/engine/localMetadataProvider";
import { runMetadataPipeline } from "../src/engine/metadataPipeline";
import { OllamaEmbeddingProvider } from "../src/engine/ollamaEmbeddingProvider";
import { evaluateConnectionQuality, type ConnectionQualityFixture, type QualityEmbedding } from "../src/quality/connectionQuality";

const repoRoot = process.cwd();
const fixturePath = path.join(repoRoot, "tests/fixtures/quality/representative-notes.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as ConnectionQualityFixture;
const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const model = process.env.OLLAMA_MODEL?.trim();

if (!model) {
  throw new Error("Set OLLAMA_MODEL to an already-installed local embedding model.");
}

if (!("window" in globalThis)) Object.defineProperty(globalThis, "window", { value: globalThis });

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error("cancelled")); return; }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true });
});
async function main(embeddingModel: string): Promise<void> {
const provider = new OllamaEmbeddingProvider({ baseUrl, model: embeddingModel, maxRetries: 0, timeoutMs: 120_000 }, { fetchImpl: fetch, sleep });

const items: { id: string; text: string }[] = [];
const chunksByPath = new Map<string, string[]>();
for (const [index, note] of fixture.notes.entries()) {
  const chunks = chunkText(note.text, { targetTokens: DEFAULT_TARGET_TOKENS, overlapTokens: DEFAULT_OVERLAP_TOKENS });
  chunksByPath.set(note.path, chunks);
  items.push({ id: `note:${index}`, text: note.text });
  chunks.forEach((text, chunkIndex) => items.push({ id: `chunk:${index}:${chunkIndex}`, text }));
}

const batch = await provider.embedBatch({ model: embeddingModel, items });
const byId = new Map(batch.items.map((item) => [item.id, Float32Array.from(item.values)]));
const embeddings = new Map<string, QualityEmbedding>();
for (const [index, note] of fixture.notes.entries()) {
  const noteVector = byId.get(`note:${index}`);
  if (!noteVector) throw new Error(`missing note vector at fixture index ${index}`);
  const chunks = chunksByPath.get(note.path) ?? [];
  embeddings.set(note.path, {
    noteVector,
    chunkVectors: chunks.map((_text, chunkIndex) => {
      const vector = byId.get(`chunk:${index}:${chunkIndex}`);
      if (!vector) throw new Error(`missing chunk vector at fixture index ${index}:${chunkIndex}`);
      return vector;
    }),
  });
}

const result = evaluateConnectionQuality(fixture, embeddings, {
  candidateLimit: 40,
  relatedLimit: 8,
  overreachCount: 2,
  creativeCount: 2,
  creativeMin: 0.45,
  creativeMax: 0.7,
  minScore: 0,
});

const report: Record<string, unknown> = { evaluation: "local-ollama-production-retrieval", model: embeddingModel, ...result };

const metadataModel = process.env.OLLAMA_METADATA_MODEL?.trim();
if (metadataModel) {
  const metadataProvider = createOllamaMetadataProvider({ baseUrl, timeoutMs: 120_000 }, { fetchImpl: fetch });
  const summaryNotes = fixture.notes.filter((_note, index) => index % 5 === 0).slice(0, 5);
  report.summaries = await Promise.all(summaryNotes.map(async (note) => {
    const output = await runMetadataPipeline(metadataProvider, {
      model: metadataModel,
      maxTokens: 256,
      contextTokens: 4096,
      tagLimit: 5,
      conceptLimit: 5,
      conceptMaxWords: 4,
      conceptCaseMode: "none",
      controlledTags: [],
      allowFreeTags: true,
      tagMinLen: 2,
      tagMaxWords: 3,
      tagAliases: {},
    }, { identity: stableNoteIdentity(canonicalizePath(note.path)), text: note.text, related: [] });
    return { path: note.path, source: note.text, summary: output.summary };
  }));
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

void main(model);
