/** Opt-in, local-only comparison. Never reads a vault, changes settings or writes an index. */
import fs from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { chunkText } from "../src/engine/chunker";
import { DEFAULT_SETTINGS } from "../src/settings";
import { createWindowSleep, normalizeVector, OllamaEmbeddingProvider, validateOllamaEndpoint } from "../src/engine/ollamaEmbeddingProvider";
import { evaluateConnectionQuality, type ConnectionQualityFixture, type QualityEmbedding } from "../src/quality/connectionQuality";
import { extendWithLargeSample, LARGE_SAMPLE_FAMILIES } from "./fixtures/large-embedding-sample";

if (!("window" in globalThis)) Object.defineProperty(globalThis, "window", { value: globalThis });
const baseUrl = validateOllamaEndpoint(process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434");
const chunkOptions = { targetTokens: DEFAULT_SETTINGS.chunkTargetTokens, overlapTokens: DEFAULT_SETTINGS.chunkOverlapTokens };
const fixture = JSON.parse(fs.readFileSync("tests/fixtures/quality/representative-notes.json", "utf8")) as ConnectionQualityFixture;
const journal: [string, string, string][] = [
  ["Quiet work", "focus", "I kept checking messages whenever writing became uncomfortable. Tomorrow I will leave the phone outside, silence notifications and write for one uninterrupted hour. Progress matters more than looking busy."],
  ["Protect attention", "focus", "Deep work requires protecting attention from interruptions. Put the phone in another room, close messaging apps and reserve a quiet block for the hardest task before opening email."],
  ["Listening without judgment", "listening", "I wanted to prepare a rebuttal instead of hearing my friend. When I stopped judging and asked what the experience felt like, the conversation opened. Listening is not the same as agreeing."],
  ["Be curious", "listening", "To understand someone, ask open questions and listen without planning the next response. Curiosity makes disagreement less threatening. Reflect back what was heard before offering advice."],
  ["Letting go", "acceptance", "Waiting for an apology keeps my attention in an argument that ended long ago. I can let the resentment pass and return to what I can change today without approving what happened."],
  ["Return to the present", "acceptance", "Acceptance does not mean surrender. Release the demand to control other people's reactions, stop rehearsing old conflicts, and choose one useful action in the present."],
  ["Small practice", "practice", "Ten minutes of slow guitar practice each morning helped more than one exhausted Sunday session. I will repeat the difficult transition carefully, then raise the tempo only when it feels easy."],
  ["Consistency over intensity", "practice", "A sustainable learning routine is short and frequent. Practice accurate repetitions with a metronome and rest before fatigue builds. Consistency beats occasional bursts of effort."],
  ["Phone repair", "distractor", "The phone stopped charging because lint blocked its USB port. A repair technician cleaned the connector, tested the cable and replaced the worn battery. This was a hardware fault, not a notification problem."],
  ["Listening equipment", "distractor", "Listening tests found a loose wire in the left studio monitor. Replace the cable and compare the frequency response. The problem is audio hardware rather than interpersonal communication."],
  ["Acceptance tests", "distractor", "Acceptance tests verify that a software release meets its requirements. Test database migrations and validate API responses in staging before production deployment. This is not a mindfulness exercise."],
  ["Daily intensity", "distractor", "Maximum-effort lifting every day increased fatigue and reduced recovery. The training program needs lighter sessions and a deload. Guitar tempo and musical learning are unrelated to this strength plan."],
];
for (const [title, theme, text] of journal) fixture.notes.push({ path: `Journal/${title}.md`, theme, text });
for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7]]) {
  fixture.queries.push({ path: `Journal/${journal[a][0]}.md`, relevant: [`Journal/${journal[b][0]}.md`] });
}
// Same opening, distinct late topic: probes the whole-note truncation risk as well
// as production's chunk refinement. Synthetic labels are fixed before model runs.
const opening = "Today I took a walk, prepared lunch, cleaned the desk and recorded ordinary details about the weather and the route home. ".repeat(35);
for (const [title, tail, match] of [
  ["Long journal focus", "The important insight was protecting attention: silence messaging apps, put the phone in another room and reserve an uninterrupted hour for difficult writing.", "Quiet work"],
  ["Long journal listening", "The important insight was listening without judgment: ask a friend open questions, reflect their feelings and stop preparing a rebuttal before they finish speaking.", "Listening without judgment"],
  ["Long journal acceptance", "The important insight was releasing resentment about an old argument: stop waiting for an apology and return attention to useful actions in the present.", "Letting go"],
]) {
  const notePath = `Journal/${title}.md`;
  fixture.notes.push({ path: notePath, theme: "long-journal", text: `${opening}\n\n${tail}` });
  fixture.queries.push({ path: notePath, relevant: [`Journal/${match}.md`] });
}
const expanded = process.env.BENCHMARK_LARGE === "1" || process.argv.includes("--large");
const diagnostic = process.argv.includes("--diagnostic");
const additionalLookups = expanded ? extendWithLargeSample(fixture) : [];

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
function cosine(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, value, i) => sum + value * b[i], 0);
}
const options = {
  candidateLimit: DEFAULT_SETTINGS.relatedCandidateLimit, relatedLimit: DEFAULT_SETTINGS.relatedLimit,
  overreachCount: DEFAULT_SETTINGS.relatedOverreach, creativeCount: DEFAULT_SETTINGS.relatedCreative,
  creativeMin: DEFAULT_SETTINGS.relatedCreativeMin, creativeMax: DEFAULT_SETTINGS.relatedCreativeMax, minScore: DEFAULT_SETTINGS.relatedMinScore,
};
const runs: Record<string, unknown>[] = [];

async function run(model: string, formatted: boolean, round: number): Promise<void> {
  const gemma = model.startsWith("embeddinggemma-2:");
  const dimension = gemma ? 768 : 1024;
  const requests: { wallMs: number; loadMs: number; serverMs: number; tokens: number }[] = [];
  const fetchMeasured: typeof fetch = async (input, init) => {
    const start = performance.now();
    const response = await fetch(input, init);
    const body = await response.text();
    const parsed = JSON.parse(body) as { load_duration?: number; total_duration?: number; prompt_eval_count?: number };
    requests.push({ wallMs: performance.now() - start, loadMs: (parsed.load_duration ?? 0) / 1e6, serverMs: (parsed.total_duration ?? 0) / 1e6, tokens: parsed.prompt_eval_count ?? 0 });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  const provider = new OllamaEmbeddingProvider({ baseUrl, model, maxRetries: 0, timeoutMs: 120_000, maxBatchSize: 16 }, { fetchImpl: fetchMeasured, sleep: createWindowSleep() });
  const formatNote = (text: string): string => formatted && gemma ? `task: sentence similarity | query: ${text}` : text;
  const items: { id: string; text: string }[] = [];
  const counts = new Map<string, number>();
  fixture.notes.forEach((note, i) => {
    const chunks = chunkText(note.text, chunkOptions);
    counts.set(note.path, chunks.length);
    items.push({ id: `n${i}`, text: formatNote(note.text) });
    chunks.forEach((chunk, c) => items.push({ id: `n${i}c${c}`, text: formatNote(chunk) }));
  });
  const started = performance.now();
  const batch = await provider.embedBatch({ model, items });
  const corpusMs = performance.now() - started;
  if (batch.dimension !== dimension) throw new Error(`Unexpected dimension for ${model}: ${batch.dimension}`);
  const vectors = new Map(batch.items.map((item) => [item.id, Float32Array.from(item.values)]));
  const embeddings = new Map<string, QualityEmbedding>();
  fixture.notes.forEach((note, i) => embeddings.set(note.path, { noteVector: vectors.get(`n${i}`)!, chunkVectors: Array.from({ length: counts.get(note.path)! }, (_, c) => vectors.get(`n${i}c${c}`)!) }));
  const singleTimes: number[] = [];
  const shortNotes = fixture.notes.filter((note) => !note.excluded && !/long/i.test(note.path));
  for (let i = 0; i < 60; i++) {
    const t = performance.now();
    const text = expanded ? shortNotes[(i * 37 + round * 13) % shortNotes.length].text : journal[i % journal.length][2];
    await provider.embedBatch({ model, items: [{ id: "latency", text: formatNote(`${text} Trial ${i}.`) }] });
    singleTimes.push(performance.now() - t);
  }
  const lookupCases = [
    ["How can I focus without checking notifications?", "Quiet work", "Protect attention"],
    ["How can I hear a friend's perspective without judging?", "Listening without judgment", "Be curious"],
    ["How do I stop dwelling on an old argument?", "Letting go", "Return to the present"],
    ["How can I improve guitar technique with short daily sessions?", "Small practice", "Consistency over intensity"],
  ];
  const lookupSources = expanded ? fixture.notes.filter((note) => !note.excluded).map((note) => ({ path: note.path, title: note.path.replace(/\.md$/, ""), text: note.text })) : journal.map(([title, , text]) => ({ path: `Journal/${title}.md`, title, text }));
  const questions = [...lookupCases.map(([query, ...relevant]) => ({ query, relevant: relevant.map((title) => `Journal/${title}.md`) })), ...additionalLookups];
  const lookupLimit = expanded ? 8 : 3;
  const documents = lookupSources.map(({ title, text }, i) => ({ id: `d${i}`, text: !formatted ? text : gemma ? `title: ${title} | text: ${text}` : expanded ? `${title}\n${text}` : text }));
  const queryItems = questions.map(({ query }, i) => ({ id: `q${i}`, text: !formatted ? query : gemma ? `task: search result | query: ${query}` : `Represent this sentence for searching relevant passages: ${query}` }));
  const lookup = await provider.embedBatch({ model, items: [...documents, ...queryItems] });
  const lookupVectors = new Map(lookup.items.map((item) => [item.id, item.values]));
  const lookupResults = questions.map(({ query, relevant }, i) => {
    const q = lookupVectors.get(`q${i}`)!;
    const ranked = lookupSources.map(({ title, path }, d) => ({ title, path, score: cosine(q, lookupVectors.get(`d${d}`)!) })).sort((a, b) => b.score - a.score);
    const firstRelevant = ranked.findIndex((item) => relevant.includes(item.path));
    return { query, relevant, k: lookupLimit, topK: ranked.slice(0, lookupLimit), recallAtK: ranked.slice(0, lookupLimit).filter((item) => relevant.includes(item.path)).length / relevant.length, reciprocalRank: firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1) };
  });
  // Probe supported context without silently truncating. Never inflate this to
  // Ollama registry's advertised 256K: Google documents 8K for this model.
  const contextText = fixture.notes.find((note) => note.path === "Journal/Long journal acceptance.md")!.text;
  const contextResponse = await fetch(`${baseUrl}/api/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: formatNote(contextText), truncate: false, options: gemma ? { num_ctx: 8192 } : undefined }), signal: AbortSignal.timeout(120_000) });
  const contextBody = await contextResponse.json() as { error?: string; prompt_eval_count?: number };
  const ps = await (await fetch(`${baseUrl}/api/ps`)).json() as { models?: { name: string; size: number; size_vram: number; context_length?: number }[] };
  const quality = evaluateConnectionQuality(fixture, embeddings, options);
  let stressDiagnostics: Record<string, unknown> | undefined;
  if (expanded && diagnostic) {
    const shortNotes = fixture.notes.filter((note) => !/long/i.test(note.path));
    const shortPaths = new Set(shortNotes.map((note) => note.path));
    const shortFixture = { notes: shortNotes, queries: fixture.queries.filter((q) => shortPaths.has(q.path)).map((q) => ({ ...q, relevant: q.relevant.filter((p) => shortPaths.has(p)) })) };
    const shortOnly = evaluateConnectionQuality(shortFixture, embeddings, options);
    const noteOnlyEmbeddings = new Map([...embeddings].map(([p, e]) => [p, { noteVector: e.noteVector, chunkVectors: [] }]));
    const noteCandidates = evaluateConnectionQuality(fixture, noteOnlyEmbeddings, { ...options, relatedLimit: 40, overreachCount: 0, creativeCount: 0 });
    const refinedTop8 = evaluateConnectionQuality(fixture, embeddings, { ...options, overreachCount: 0, creativeCount: 0 });
    const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
    const stressQueries = (queries: typeof quality.queries) => queries.filter((q) => q.path.startsWith("Expanded/") && q.path.includes("/Long reflection"));
    const nc = stressQueries(noteCandidates.queries);
    stressDiagnostics = {
      shortOnlyCorpus: { notes: shortNotes.length, quality: shortOnly },
      longQueryWholeNoteCandidateRecallAt40: mean(nc.map((q) => q.recallAtK)),
      longQueryCandidateFractionSharedBackground: mean(nc.map((q) => q.returned.filter((p) => p.includes("/Long reflection")).length / q.returned.length)),
      longQueryRefinedTop8Recall: mean(stressQueries(refinedTop8.queries).map((q) => q.recallAtK)),
      longQuerySelectedTop8Recall: mean(stressQueries(quality.queries).map((q) => q.recallAtK)),
    };
  }
  const longNoteRanks = fixture.queries.filter((query) => /long/i.test(query.path)).map((query) => {
    const q = embeddings.get(query.path)!.noteVector;
    const ranked = fixture.notes.filter((n) => !n.excluded && n.path !== query.path).map((n) => ({ path: n.path, score: cosine([...q], [...embeddings.get(n.path)!.noteVector]) })).sort((a, b) => b.score - a.score);
    return { path: query.path, expected: query.relevant[0], wholeNoteRank: ranked.findIndex((n) => n.path === query.relevant[0]) + 1 };
  });
  // A 256d slice is only an exploratory MRL ranking test, not a runtime-speed test.
  const truncated = gemma && (!expanded || process.env.BENCHMARK_MRL === "1") ? evaluateConnectionQuality(fixture, new Map([...embeddings].map(([p, e]) => [p, { noteVector: Float32Array.from(normalizeVector([...e.noteVector.slice(0, 256)])), chunkVectors: e.chunkVectors.map((v) => Float32Array.from(normalizeVector([...v.slice(0, 256)]))) }])), options) : undefined;
  runs.push({ round, model, profile: formatted ? "task-correct" : "current-raw", dimension, corpusInputs: items.length, corpusMs, warmSingle: { samples: singleTimes.length, medianMs: percentile(singleTimes, .5), p95Ms: percentile(singleTimes, .95), valuesMs: singleTimes }, loadedModel: ps.models?.find((m) => m.name === model), contextProbe: { status: contextResponse.status, error: contextBody.error, tokens: contextBody.prompt_eval_count }, quality, longNoteRanks, lookupResults, truncated256: truncated, stressDiagnostics, requests });
  process.stderr.write(`Finished round ${round}: ${model} ${formatted ? "task-correct" : "raw"}\n`);
}

async function main(): Promise<void> {
  const tags = await (await fetch(`${baseUrl}/api/tags`)).json() as { models: { name: string; digest: string; size: number }[] };
  const version = await (await fetch(`${baseUrl}/api/version`)).json();
  const initialPs = await (await fetch(`${baseUrl}/api/ps`)).json();
  const models = ["mxbai-embed-large:latest", "embeddinggemma-2:270m"];
  const modelFilter = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);
  if (modelFilter && !models.includes(modelFilter)) throw new Error("The model filter must name one of the two comparison models.");
  if (process.env.BENCHMARK_REVERSE === "1") models.reverse();
  for (const model of models) {
    if (!tags.models.some((entry) => entry.name === model)) throw new Error(`Install ${model} before running this opt-in benchmark.`);
  }
  for (const round of diagnostic ? [1] : [1, 2]) {
    for (const model of round === 1 ? models : [...models].reverse()) {
      if (modelFilter && model !== modelFilter) continue;
      for (const formatted of diagnostic ? [!process.argv.includes("--raw")] : [false, true]) await run(model, formatted, round);
    }
  }
  process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), environment: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem(), ollama: version, initialPs }, models: tags.models.filter((m) => /^(mxbai-embed-large|embeddinggemma-2):/.test(m.name)), methodology: { corpusNotes: fixture.notes.length, queries: fixture.queries.length, expandedFamilies: expanded ? LARGE_SAMPLE_FAMILIES.length : 0, fixtureSha256: createHash("sha256").update(JSON.stringify(fixture)).digest("hex"), judgments: "Sparse, synthetic expected links; unlabelled results are not proven irrelevant. No private notes used.", chunks: chunkOptions, ranking: options, timing: "Sequential local runs, no forced model eviction, no UI latency measurement; corpus includes load overhead. API /ps allocation is not process RSS or peak memory." }, fixture: expanded ? fixture : undefined, runs }, null, 2) + "\n");
}
void main();
