import { createHash } from "node:crypto";
import { EngineError } from "./errors";
import type { ChatMessage, MetadataInferenceProvider, MetadataInferenceProviderCallOptions, MetadataInferenceRequest, MetadataNodeCache } from "./metadataPipeline";
import { parseMetadataResponse } from "./metadataPipeline";
import { assertFitsInputBudget, messagesTotalBytes, type ResolvedBudget } from "./metadataBudget";

export interface IntermediateMetadata {
  summary: string;
  tags: string[];
  concepts: string[];
}

const MAX_INTERMEDIATE_SUMMARY_LENGTH = 2000;
const MAX_INTERMEDIATE_TAG_COUNT = 50;
const MAX_INTERMEDIATE_CONCEPT_COUNT = 50;
const MAX_INTERMEDIATE_ENTRY_LENGTH = 500;
const MAX_REDUCTION_DEPTH = 20;

export function validateIntermediate(raw: { summary: string; tags: string[]; concepts: string[] }): IntermediateMetadata {
  if (typeof raw.summary !== "string") {
    throw new EngineError("METADATA_RESPONSE_INVALID", "Intermediate metadata summary must be a string.");
  }
  const summary = raw.summary.trim();
  if (summary.length > MAX_INTERMEDIATE_SUMMARY_LENGTH) {
    throw new EngineError("METADATA_RESPONSE_INVALID", `Intermediate summary exceeds ${MAX_INTERMEDIATE_SUMMARY_LENGTH} characters.`);
  }

  if (!Array.isArray(raw.tags)) {
    throw new EngineError("METADATA_RESPONSE_INVALID", "Intermediate metadata tags must be an array.");
  }
  const tags: string[] = [];
  for (const t of raw.tags) {
    if (typeof t !== "string") continue;
    const trimmed = t.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_INTERMEDIATE_ENTRY_LENGTH) {
      throw new EngineError("METADATA_RESPONSE_INVALID", `Intermediate tag exceeds ${MAX_INTERMEDIATE_ENTRY_LENGTH} characters.`);
    }
    tags.push(trimmed);
  }
  if (tags.length > MAX_INTERMEDIATE_TAG_COUNT) {
    throw new EngineError("METADATA_RESPONSE_INVALID", `Intermediate tags exceed ${MAX_INTERMEDIATE_TAG_COUNT} entries.`);
  }

  if (!Array.isArray(raw.concepts)) {
    throw new EngineError("METADATA_RESPONSE_INVALID", "Intermediate metadata concepts must be an array.");
  }
  const concepts: string[] = [];
  for (const c of raw.concepts) {
    if (typeof c !== "string") continue;
    const trimmed = c.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_INTERMEDIATE_ENTRY_LENGTH) {
      throw new EngineError("METADATA_RESPONSE_INVALID", `Intermediate concept exceeds ${MAX_INTERMEDIATE_ENTRY_LENGTH} characters.`);
    }
    concepts.push(trimmed);
  }
  if (concepts.length > MAX_INTERMEDIATE_CONCEPT_COUNT) {
    throw new EngineError("METADATA_RESPONSE_INVALID", `Intermediate concepts exceed ${MAX_INTERMEDIATE_CONCEPT_COUNT} entries.`);
  }

  return { summary, tags, concepts };
}

export function buildReductionMessages(intermediates: readonly IntermediateMetadata[]): ChatMessage[] {
  const system = "You merge partial metadata extracts into one combined extract. Return exactly one JSON object.";
  const parts = intermediates.map((im, i) =>
    `Part ${i + 1}:\nSummary: ${im.summary}\nTags: ${im.tags.join(", ")}\nConcepts: ${im.concepts.join(", ")}`,
  );
  const user = [
    "Merge the following partial metadata extracts into one combined extract.",
    'Return a single JSON object: {"summary":"...","tags":[...],"concepts":[...]}.',
    "Combine summaries into 1-2 sentences. Deduplicate and keep the most relevant tags and concepts.",
    "",
    ...parts,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export interface ReductionOptions {
  provider: MetadataInferenceProvider;
  model: string;
  contextTokens: number;
  budget: ResolvedBudget;
  rootBudget?: ResolvedBudget;
  nodeCache?: MetadataNodeCache;
  nodeCacheKeyPrefix?: string;
  signal?: AbortSignal;
}

export async function reduceIntermediates(
  intermediates: IntermediateMetadata[],
  options: ReductionOptions,
): Promise<IntermediateMetadata> {
  if (intermediates.length === 0) {
    throw new EngineError("METADATA_CONFIG_INVALID", "No intermediates to reduce.");
  }
  let current = intermediates;
  let depth = 0;

  while (current.length > 1) {
    if (depth >= MAX_REDUCTION_DEPTH) {
      throw new EngineError("METADATA_CONFIG_INVALID", "Reduction exceeded maximum depth without converging to one root.");
    }
    const groups = packGroups(current, options.budget);
    if (groups.length >= current.length) {
      throw new EngineError("METADATA_CONFIG_INVALID", "Reduction group did not strictly decrease in size; cannot converge.");
    }
    const next: IntermediateMetadata[] = [];
    for (const group of groups) {
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      const result = await reduceOneGroup(group, options, "reduce");
      next.push(result);
    }
    current = next;
    depth++;
  }
  return reduceOneGroup([current[0]], options, "root");
}

function packGroups(
  intermediates: IntermediateMetadata[],
  budget: ResolvedBudget,
): IntermediateMetadata[][] {
  const groups: IntermediateMetadata[][] = [];
  let current: IntermediateMetadata[] = [];

  for (const im of intermediates) {
    const candidate = [...current, im];
    const messages = buildReductionMessages(candidate);
    const totalBytes = messagesTotalBytes(messages);
    if (totalBytes > budget.inputBudgetBytes && current.length > 0) {
      groups.push(current);
      current = [im];
      if (messagesTotalBytes(buildReductionMessages(current)) > budget.inputBudgetBytes) {
        throw new EngineError("METADATA_CONFIG_INVALID", "An intermediate record exceeds the reduction input budget.");
      }
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

async function reduceOneGroup(
  group: IntermediateMetadata[],
  options: ReductionOptions,
  kind: "reduce" | "root",
): Promise<IntermediateMetadata> {
  if (options.signal?.aborted) {
    throw new EngineError("METADATA_CANCELLED", "Metadata reduction was cancelled.");
  }
  const budget = kind === "root" ? (options.rootBudget ?? options.budget) : options.budget;
  const messages = buildReductionMessages(group);
  assertFitsInputBudget(messages, budget);
  const groupDigest = createHash("sha256").update(JSON.stringify(group), "utf8").digest("hex");
  const cacheKey = JSON.stringify([options.nodeCacheKeyPrefix ?? "metadata", kind, groupDigest]);
  const cached = options.nodeCache?.get(cacheKey);
  if (cached) return validateIntermediate(cached);
  const request: MetadataInferenceRequest = {
    model: options.model,
    messages,
    maxTokens: budget.maxOutputTokens,
    contextTokens: options.contextTokens,
  };
  const callOptions: MetadataInferenceProviderCallOptions = { signal: options.signal };

  // One retry on METADATA_RESPONSE_INVALID for reduction calls.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (options.signal?.aborted) {
      throw new EngineError("METADATA_CANCELLED", "Metadata reduction was cancelled.");
    }
    try {
      const raw = await options.provider.complete(request, callOptions);
      const parsed = parseMetadataResponse(raw);
      const result = validateIntermediate(parsed);
      options.nodeCache?.set(cacheKey, result);
      return result;
    } catch (error) {
      if (error instanceof EngineError) {
        if (error.code === "METADATA_RESPONSE_INVALID" && attempt === 0) {
          lastError = error;
          continue;
        }
        throw error;
      }
      throw new EngineError("METADATA_PROVIDER_FAILED", "Metadata inference provider call failed during reduction.");
    }
  }
  throw lastError;
}
