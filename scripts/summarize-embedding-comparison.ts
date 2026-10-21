/** Summarize saved local runs; resample topic families, never repeated runs as independent queries. */
import fs from "node:fs";
import type { ConnectionQualityFixture, QueryQualityResult } from "../src/quality/connectionQuality";

interface Run {
  model: string; profile: string; round: number; corpusMs: number; corpusInputs: number;
  warmSingle: { valuesMs: number[] };
  quality: { queries: QueryQualityResult[]; selfHits: number };
  lookupResults: { query: string; relevant: string[]; recallAtK: number; reciprocalRank: number }[];
  loadedModel?: { size: number };
  stressDiagnostics?: {
    shortOnlyCorpus: { notes: number; quality: { queries: QueryQualityResult[]; recallAtK: number; meanReciprocalRank: number } };
    longQueryWholeNoteCandidateRecallAt40: number;
    longQueryCandidateFractionSharedBackground: number;
    longQueryRefinedTop8Recall: number;
    longQuerySelectedTop8Recall: number;
  };
}
interface Report { fixture: ConnectionQualityFixture; methodology: unknown; generatedAt: string; runs: Run[] }
const filename = process.argv[2];
if (!filename) throw new Error("Pass the saved comparison JSON path.");
const report = JSON.parse(fs.readFileSync(filename, "utf8")) as Report;
if (!report.fixture || !report.runs?.length) throw new Error("This summary requires a completed --large comparison report.");
const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
const percentile = (values: number[], p: number): number => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const aggregate = (runs: Run[], predicate: (q: QueryQualityResult) => boolean) => {
  const qs = runs[0].quality.queries.filter(predicate);
  const metrics = qs.map((q) => runs.map((r) => r.quality.queries.find((other) => other.path === q.path)!));
  return {
    queries: qs.length,
    expectedLinks: qs.reduce((sum, q) => sum + report.fixture.queries.find((f) => f.path === q.path)!.relevant.length, 0),
    foundLinksMeanAcrossRounds: metrics.reduce((sum, values) => sum + mean(values.map((v) => v.relevantReturned.length)), 0),
    recallAt8: mean(metrics.map((values) => mean(values.map((v) => v.recallAtK)))),
    mrr: mean(metrics.map((values) => mean(values.map((v) => v.reciprocalRank)))),
    expectedTop1Rate: mean(metrics.map((values) => mean(values.map((v) => Number(v.reciprocalRank === 1))))),
  };
};
const summaries = [];
for (const model of [...new Set(report.runs.map((r) => r.model))]) {
  for (const profile of ["current-raw", "task-correct"]) {
    const runs = report.runs.filter((r) => r.model === model && r.profile === profile);
    const values = runs.flatMap((r) => r.warmSingle.valuesMs);
    summaries.push({
      model, profile, rounds: runs.length, corpusInputs: runs[0].corpusInputs, corpusMs: runs.map((r) => r.corpusMs),
      warmSamples: values.length, medianMs: percentile(values, .5), p95Ms: percentile(values, .95),
      allocationBytes: runs[0].loadedModel?.size,
      all: aggregate(runs, () => true),
      newFamilies: aggregate(runs, (q) => q.path.startsWith("Expanded/")),
      newShort: aggregate(runs, (q) => q.path.startsWith("Expanded/") && !q.path.includes("/Long reflection")),
      newLong: aggregate(runs, (q) => q.path.startsWith("Expanded/") && q.path.includes("/Long reflection")),
      legacy: aggregate(runs, (q) => !q.path.startsWith("Expanded/")),
      selfHitsAcrossRounds: runs.reduce((sum, r) => sum + r.quality.selfHits, 0),
      lookup: { queries: runs[0].lookupResults.length, recallAt8: mean(runs.flatMap((r) => r.lookupResults.map((q) => q.recallAtK))), mrr: mean(runs.flatMap((r) => r.lookupResults.map((q) => q.reciprocalRank))) },
    });
  }
}
const families = [...new Set(report.fixture.notes.map((n) => n.theme).filter((t) => t.startsWith("expanded:")))];
const baselines = report.runs.filter((r) => r.profile === "task-correct" && r.model.startsWith("mxbai"));
const candidates = report.runs.filter((r) => r.profile === "task-correct" && r.model.startsWith("embeddinggemma"));
let seed = 20261015;
const random = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
const pairedConfidence = [];
for (const cohort of ["newFamilies", "newShort", "newLong"]) {
  for (const metric of ["recallAtK", "reciprocalRank"] as const) {
    const deltas = families.map((family) => {
      const paths = new Set(report.fixture.notes.filter((n) => n.theme === family && (cohort === "newFamilies" || n.path.includes("/Long reflection") === (cohort === "newLong"))).map((n) => n.path));
      const score = (runs: Run[]): number => mean(runs.map((r) => mean(r.quality.queries.filter((q) => paths.has(q.path)).map((q) => q[metric]))));
      return score(candidates) - score(baselines);
    });
    const draws = Array.from({ length: 5000 }, () => mean(Array.from({ length: families.length }, () => deltas[Math.floor(random() * deltas.length)])));
    pairedConfidence.push({ cohort, metric, independentFamilies: families.length, gemmaMinusMxbai: mean(deltas), bootstrap95: [percentile(draws, .025), percentile(draws, .975)] });
  }
}
const diagnosticRuns = process.argv.slice(3).flatMap((file) => (JSON.parse(fs.readFileSync(file, "utf8")) as Report).runs).filter((run) => run.stressDiagnostics);
const diagnosticSummaries = diagnosticRuns.map((run) => ({
  model: run.model, profile: run.profile,
  shortOnlyNotes: run.stressDiagnostics!.shortOnlyCorpus.notes,
  shortOnlyQueries: run.stressDiagnostics!.shortOnlyCorpus.quality.queries.length,
  shortOnlyRecallAt8: run.stressDiagnostics!.shortOnlyCorpus.quality.recallAtK,
  shortOnlyMRR: run.stressDiagnostics!.shortOnlyCorpus.quality.meanReciprocalRank,
  longQueryCandidateRecallAt40: run.stressDiagnostics!.longQueryWholeNoteCandidateRecallAt40,
  longQueryCandidateFractionSharedBackground: run.stressDiagnostics!.longQueryCandidateFractionSharedBackground,
  longQueryRefinedRecallAt8: run.stressDiagnostics!.longQueryRefinedTop8Recall,
  longQuerySelectedRecallAt8: run.stressDiagnostics!.longQuerySelectedTop8Recall,
}));
const diagnosticBaseline = diagnosticRuns.find((r) => r.model.startsWith("mxbai"));
if (diagnosticBaseline) {
  for (const candidate of diagnosticRuns.filter((r) => r.model.startsWith("embeddinggemma"))) {
    for (const metric of ["recallAtK", "reciprocalRank"] as const) {
      const score = (run: Run, paths: Set<string>): number => mean(run.stressDiagnostics!.shortOnlyCorpus.quality.queries.filter((q) => paths.has(q.path)).map((q) => q[metric]));
      const deltas = families.map((family) => {
        const paths = new Set(report.fixture.notes.filter((n) => n.theme === family && !n.path.includes("/Long reflection")).map((n) => n.path));
        return score(candidate, paths) - score(diagnosticBaseline, paths);
      });
      const draws = Array.from({ length: 5000 }, () => mean(Array.from({ length: families.length }, () => deltas[Math.floor(random() * deltas.length)])));
      pairedConfidence.push({ cohort: `shortOnly:${candidate.profile}`, metric, independentFamilies: families.length, gemmaMinusMxbai: mean(deltas), bootstrap95: [percentile(draws, .025), percentile(draws, .975)] });
    }
  }
}
process.stdout.write(JSON.stringify({ generatedAt: report.generatedAt, methodology: report.methodology, summaries, pairedConfidence, diagnosticSummaries, confidenceMethod: "5,000 paired topic-family bootstrap draws; average repeated runs within each query first; synthetic family labels are not independent real-user judgments." }, null, 2) + "\n");
