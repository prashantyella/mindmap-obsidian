export function resolveLocalModelApiKey(config: Record<string, unknown>, environment: Record<string, string | undefined>): string {
  const environmentName = typeof config.llm_api_key_env === "string" ? config.llm_api_key_env.trim() : "";
  if (environmentName) return environment[environmentName] ?? "";
  return typeof config.llm_api_key === "string" ? config.llm_api_key.trim() : "";
}
