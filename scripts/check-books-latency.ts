/** Read-only paired latency control; stdout never contains source text or paths. */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { projectSource } from "../src/engine/sourceProjection";
import { canonicalizePath, stableNoteIdentity } from "../src/engine/contracts";
import { createWindowSleep, OllamaEmbeddingProvider } from "../src/engine/ollamaEmbeddingProvider";

if (!("window" in globalThis)) Object.defineProperty(globalThis, "window", { value: globalThis });
const value = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const vault = fs.realpathSync(value("--vault"));
const privateDir = value("--private-dir");
const words = (s: string) => s.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu)?.length ?? 0;
const questions = JSON.parse(fs.readFileSync(path.join(privateDir, "questions.json"), "utf8")) as { sourcePath: string }[];
const bodies = questions.map(({ sourcePath }) => {
  const canonical = canonicalizePath(sourcePath);
  const absolute = fs.realpathSync(path.join(vault, canonical));
  if (!absolute.startsWith(path.join(vault, "Books") + path.sep)) throw new Error("Source is outside Books.");
  return projectSource(stableNoteIdentity(canonical), fs.readFileSync(absolute, "utf8")).projectedBody;
}).sort((a, b) => words(a) - words(b));
const conditions = [
  { id: "synthetic-control", text: "Protect attention by leaving the phone outside and silencing notifications during a quiet hour of writing." },
  { id: "books-short", text: bodies[0] },
  { id: "books-median", text: bodies[Math.floor(bodies.length / 2)] },
  { id: "books-long-sampled", text: bodies[bodies.length - 1] },
];
async function main(): Promise<void> {
  const results = [];
  for (const round of [1, 2]) {
    const models = ["mxbai-embed-large:latest", "embeddinggemma-2:270m"];
    for (const model of round === 1 ? models : models.reverse()) {
      const provider = new OllamaEmbeddingProvider({ baseUrl: "http://127.0.0.1:11434", model, maxRetries: 0 }, { fetchImpl: fetch, sleep: createWindowSleep() });
      for (const condition of conditions) {
        const times = [];
        for (let i = 0; i < 24; i++) {
          const start = performance.now();
          await provider.embedBatch({ model, items: [{ id: "latency", text: condition.text }] });
          if (i >= 4) times.push(performance.now() - start);
        }
        times.sort((a, b) => a - b);
        results.push({ round, model, condition: condition.id, words: words(condition.text), medianMs: times[9], p95Ms: times[18], valuesMs: times });
      }
    }
  }
  process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + "\n");
}
void main();
