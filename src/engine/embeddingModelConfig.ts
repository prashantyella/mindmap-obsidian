/** Native dimensions only; unlisted/custom models require an explicit setting. */
const KNOWN_DIMENSIONS: Readonly<Record<string, number>> = {
  "mxbai-embed-large": 1024,
  "nomic-embed-text": 768,
  "all-minilm": 384,
  "bge-m3": 1024,
  "bge-large": 1024,
  "snowflake-arctic-embed": 1024,
  "embeddinggemma": 768,
  "embeddinggemma-2": 768,
};

export function resolveKnownEmbeddingDimension(model: string, explicitOverride: number | undefined): number | undefined {
  if (explicitOverride !== undefined) return explicitOverride;
  const name = model.replace(/:[^/]*$/, "");
  return Object.prototype.hasOwnProperty.call(KNOWN_DIMENSIONS, name) ? KNOWN_DIMENSIONS[name] : undefined;
}
