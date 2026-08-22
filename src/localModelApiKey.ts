/**
 * Trims the resolved key on every path (including the environment variable,
 * which process.env does not trim) before any caller uses its truthiness to
 * select an authentication mode: an untrimmed whitespace-only value would
 * otherwise read as "present" and trigger a Bearer header with a garbage
 * token.
 */
export function resolveLocalModelApiKey(config: Record<string, unknown>, environment: Record<string, string | undefined>): string {
  const environmentName = typeof config.llm_api_key_env === "string" ? config.llm_api_key_env.trim() : "";
  if (environmentName) return (environment[environmentName] ?? "").trim();
  return typeof config.llm_api_key === "string" ? config.llm_api_key.trim() : "";
}
