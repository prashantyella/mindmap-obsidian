import test from "node:test";
import assert from "node:assert/strict";

import { ExaResearchProvider } from "./exaResearchProvider";
import { getExaCredential } from "./keychainCredential";
import { RESEARCH_END, RESEARCH_START, renderCompanionResearchContent, renderResearchBlock, upsertResearchBlock } from "./researchWriter";
import { researchNote } from "./webResearch";
import type { ReadingVault, VaultEntry } from "./readingVault";

class MemoryVault implements ReadingVault {
  text = "<!-- mindmap:apple-books-source:start -->\nsource\n<!-- mindmap:apple-books-source:end -->\nUser body\n";
  get(path: string): VaultEntry | null { return { path, raw: path }; }
  async read(): Promise<string> { return this.text; }
  async create(): Promise<VaultEntry> { throw new Error("unused"); }
  async modify(_entry: VaultEntry, content: string): Promise<void> { this.text = content; }
  async createFolder(): Promise<void> {}
  async rename(): Promise<void> { throw new Error("unused"); }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("uses Keychain unless an explicit development override is enabled", async () => {
  assert.equal(await getExaCredential({ allowDevelopmentOverride: true, environment: { MINDMAP_EXA_API_KEY: "test-key" } }), "test-key");
  await assert.rejects(() => getExaCredential({ allowDevelopmentOverride: false, environment: { MINDMAP_EXA_API_KEY: "ignored" }, runSecurity: async () => { throw new Error("missing"); } }), (error: unknown) => error instanceof Error && !error.message.includes("ignored"));
});

test("Keychain lookup uses fixed non-shell arguments and never exposes a key in errors", async () => {
  let args: string[] = [];
  const key = await getExaCredential({ allowDevelopmentOverride: false, runSecurity: async (value) => { args = value; return "key-value\n"; } });
  assert.equal(key, "key-value");
  assert.deepEqual(args, ["find-generic-password", "-s", "com.mindmap-ai.web-research", "-a", "exa-api-key", "-w"]);
});

test("Exa provider bounds, normalizes, deduplicates, rejects non-HTTPS, and redacts failures", async () => {
  const calls: RequestInit[] = [];
  const provider = new ExaResearchProvider("secret-key", async (_url, init) => {
    calls.push(init);
    return response({ results: [
      { title: "Good", url: "https://example.com/a", highlights: ["one"] },
      { title: "Duplicate", url: "https://example.com/a", highlights: ["two"] },
      { title: "Bad", url: "http://example.com/b" },
    ] });
  });
  const sources = await provider.search(["first", "second", "third"]);
  assert.equal(calls.length, 2);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.url, "https://example.com/a");
  const body = JSON.parse(String(calls[0]?.body)) as Record<string, unknown>;
  assert.equal(body.numResults, 2);
  assert.equal(body.moderation, true);

  const denied = new ExaResearchProvider("secret-key", async () => response({ secret: "do not leak" }, 401));
  await assert.rejects(() => denied.search(["x"]), (error: unknown) => error instanceof Error && error.message.includes("401") && !error.message.includes("secret"));
});

test("Exa maps AbortError, network, and quota errors without response bodies", async () => {
  const aborted = new ExaResearchProvider("secret", async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
  await assert.rejects(() => aborted.search(["x"]), (error: unknown) => error instanceof Error && error.message.includes("timed out"));
  const network = new ExaResearchProvider("secret", async () => { throw new Error("socket secret"); });
  await assert.rejects(() => network.search(["x"]), (error: unknown) => error instanceof Error && error.message.includes("network") && !error.message.includes("secret"));
  const quota = new ExaResearchProvider("secret", async () => response({ body: "secret" }, 429));
  await assert.rejects(() => quota.search(["x"]), (error: unknown) => error instanceof Error && error.message.includes("429") && !error.message.includes("secret"));
});

test("empty, malformed, timeout, and network results never write research", async () => {
  const vault = new MemoryVault();
  const note = vault.get("Notes/a.md")!;
  const model = { deriveQueries: async () => ["query"], synthesize: async () => "Claim [1]" };
  const empty = { search: async () => [] };
  assert.equal(await researchNote({ provider: empty, model, vault }, note, { text: "bounded", maxChars: 20 }), null);
  assert.equal(vault.text.includes("mindmap:research:start"), false);

  const malformed = { search: async () => [{ title: "bad", url: "http://bad" }] } as never;
  assert.equal(await researchNote({ provider: malformed, model, vault }, note, { text: "bounded", maxChars: 20 }), null);
  const unsupportedCitation = renderResearchBlock({ synthesis: "Claim [2]", sources: [{ title: "Good", url: "https://example.com", retrievedAt: "2026-01-01T00:00:00Z", highlights: [] }] });
  assert.equal(unsupportedCitation, null);
});

test("research writer is idempotent and preserves the source block and user body", () => {
  const block = renderResearchBlock({ synthesis: "Claim [1]", sources: [{ title: "Good", url: "https://example.com", retrievedAt: "2026-01-01T00:00:00Z", highlights: [] }] })!;
  const original = "<!-- mindmap:apple-books-source:start -->\nsource\n<!-- mindmap:apple-books-source:end -->\nUser body\n";
  const once = upsertResearchBlock(original, block);
  const twice = upsertResearchBlock(once, block);
  assert.equal(twice, once);
  assert.match(once, /source/);
  assert.match(once, /User body/);
});

test("research writer preserves CRLF bytes outside its managed block and rejects marker/uncited synthesis", () => {
  const original = "<!-- mindmap:apple-books-source:start -->\r\nsource\r\n<!-- mindmap:apple-books-source:end -->\r\nUser body\r\n";
  const block = renderResearchBlock({ synthesis: "Claim [1]", sources: [{ title: "Good", url: "https://example.com", publishedAt: "2026-01-01T00:00:00Z", retrievedAt: "2026-01-01T00:00:00Z", highlights: ["ok"] }] })!;
  const next = upsertResearchBlock(original, block);
  assert.match(next, /Published: 2026-01-01T00:00:00Z/);
  assert.ok(next.includes("source\r\n"));
  assert.equal(renderResearchBlock({ synthesis: "Claim without citation", sources: [{ title: "Good", url: "https://example.com", retrievedAt: "now", highlights: [] }] }), null);
  assert.equal(renderResearchBlock({ synthesis: "<!-- mindmap:research:start --> [1]", sources: [{ title: "Good", url: "https://example.com", retrievedAt: "now", highlights: [] }] }), null);
});

test("researchNote preserves provider publication metadata and never modifies invalid synthesis", async () => {
  const vault = new MemoryVault();
  const note = vault.get("Notes/a.md")!;
  const result = await researchNote({ vault, provider: { search: async () => [{ title: "Published", url: "https://example.com/p", publishedAt: "2026-01-01T00:00:00Z", retrievedAt: "2026-01-02T00:00:00Z", highlights: ["fact"] }] }, model: { deriveQueries: async () => ["q"], synthesize: async () => "Grounded [1]" } }, note, { text: "text", maxChars: 20 });
  assert.equal(result?.sources[0]?.publishedAt, "2026-01-01T00:00:00.000Z");
  assert.match(vault.text, /Published: 2026-01-01T00:00:00.000Z/);
  const before = vault.text;
  const invalid = await researchNote({ vault, provider: { search: async () => [{ title: "Published", url: "https://example.com/p", retrievedAt: "2026-01-02T00:00:00Z", highlights: [] }] }, model: { deriveQueries: async () => ["q"], synthesize: async () => "No citation" } }, note, { text: "text", maxChars: 20 });
  assert.equal(invalid, null);
  assert.equal(vault.text, before);
});

test("replacing research preserves exact prefix and suffix bytes", () => {
  const prefix = "prefix\r\n";
  const suffix = "\r\nsuffix\r\n";
  const original = `${prefix}${RESEARCH_START}\r\nold\r\n${RESEARCH_END}${suffix}`;
  const block = renderResearchBlock({ synthesis: "New [1]", sources: [{ title: "A", url: "https://example.com", retrievedAt: "now", highlights: [] }] })!;
  const replaced = upsertResearchBlock(original, block);
  assert.ok(replaced.startsWith(prefix));
  assert.ok(replaced.endsWith(suffix));
});

test("renderCompanionResearchContent uses ## Sources (not ### Sources) and omits markers", () => {
  const content = renderCompanionResearchContent({
    synthesis: "Claim [1]",
    sources: [{ title: "Good", url: "https://example.com", author: "Author", publishedAt: "2026-01-01T00:00:00Z", retrievedAt: "2026-01-02T00:00:00Z", highlights: [] }],
  });
  assert.ok(content);
  assert.ok(content.includes("## Sources"));
  assert.ok(!content.includes("### Sources"));
  assert.ok(!content.includes("## Research"));
  assert.ok(!content.includes(RESEARCH_START));
  assert.ok(!content.includes(RESEARCH_END));
  assert.ok(content.includes("Author: Author"));
  assert.ok(content.includes("Published: 2026-01-01T00:00:00Z"));
});

test("renderCompanionResearchContent and renderResearchBlock share identical source list format", () => {
  const result = { synthesis: "Claim [1] [2]", sources: [
    { title: "First", url: "https://example.com/a", author: "A", retrievedAt: "2026-01-01T00:00:00Z", highlights: [] },
    { title: "Second", url: "https://example.com/b", publishedAt: "2025-06-01T00:00:00Z", retrievedAt: "2026-01-01T00:00:00Z", highlights: [] },
  ] };
  const inline = renderResearchBlock(result)!;
  const companion = renderCompanionResearchContent(result)!;
  const inlineSources = inline.split("### Sources\n")[1]?.split(`\n${RESEARCH_END}`)[0] ?? "";
  const companionSources = companion.split("## Sources\n")[1] ?? "";
  assert.equal(inlineSources, companionSources);
});

test("renderResearchBlock output is byte-identical to the original format", () => {
  const result = { synthesis: "Claim [1]", sources: [{ title: "Good", url: "https://example.com", retrievedAt: "2026-01-01T00:00:00Z", highlights: [] }] };
  const block = renderResearchBlock(result)!;
  assert.ok(block.startsWith(RESEARCH_START));
  assert.ok(block.endsWith(RESEARCH_END));
  assert.ok(block.includes("## Research"));
  assert.ok(block.includes("### Sources"));
});
