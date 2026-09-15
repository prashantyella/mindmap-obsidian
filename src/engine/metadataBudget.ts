import { EngineError } from "./errors";

export const DEFAULT_CONTEXT_TOKENS = 4096;
const MIN_CONTEXT_TOKENS = 512;
const MAX_CONTEXT_TOKENS = 131_072;

export const CHAT_TEMPLATE_RESERVE_BYTES = 512;
const LEAF_OUTPUT_ALLOWANCE = 256;

export interface ResolvedBudget {
  contextTokens: number;
  maxOutputTokens: number;
  inputBudgetBytes: number;
}

export function validateContextTokens(contextTokens: number | undefined): number {
  const resolved = contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  if (!Number.isInteger(resolved) || resolved < MIN_CONTEXT_TOKENS || resolved > MAX_CONTEXT_TOKENS) {
    throw new EngineError("METADATA_CONFIG_INVALID", `contextTokens must be an integer between ${MIN_CONTEXT_TOKENS} and ${MAX_CONTEXT_TOKENS}.`);
  }
  return resolved;
}

export function resolveRootBudget(contextTokens: number, maxTokens: number): ResolvedBudget {
  const inputBudgetBytes = contextTokens - CHAT_TEMPLATE_RESERVE_BYTES - maxTokens;
  if (inputBudgetBytes <= 0) {
    throw new EngineError("METADATA_CONFIG_INVALID", "contextTokens is too small for the configured maxTokens and chat-template reserve.");
  }
  return { contextTokens, maxOutputTokens: maxTokens, inputBudgetBytes };
}

export function resolveLeafBudget(contextTokens: number): ResolvedBudget {
  const inputBudgetBytes = contextTokens - CHAT_TEMPLATE_RESERVE_BYTES - LEAF_OUTPUT_ALLOWANCE;
  if (inputBudgetBytes <= 0) {
    throw new EngineError("METADATA_CONFIG_INVALID", "contextTokens is too small for the leaf output allowance and chat-template reserve.");
  }
  return { contextTokens, maxOutputTokens: LEAF_OUTPUT_ALLOWANCE, inputBudgetBytes };
}

export function assertPositiveInputBudget(budget: ResolvedBudget): void {
  if (budget.inputBudgetBytes <= 0) {
    throw new EngineError("METADATA_CONFIG_INVALID", "The chat wrapper and output allowance leave no input capacity.");
  }
}

export function messagesTotalBytes(messages: readonly { content: string }[]): number {
  let total = 0;
  for (const msg of messages) {
    total += Buffer.byteLength(msg.content, "utf8");
  }
  return total;
}

export function fitsInputBudget(messages: readonly { content: string }[], budget: ResolvedBudget): boolean {
  return messagesTotalBytes(messages) <= budget.inputBudgetBytes;
}

export function assertFitsInputBudget(messages: readonly { content: string }[], budget: ResolvedBudget): void {
  const total = messagesTotalBytes(messages);
  if (total > budget.inputBudgetBytes) {
    throw new EngineError("METADATA_PROMPT_TOO_LARGE", "Constructed request exceeds the resolved input byte budget.", { totalBytes: total, budgetBytes: budget.inputBudgetBytes });
  }
}
