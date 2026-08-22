import {
  READING_ANNOTATIONS_FOLDER,
  hasControlOrDelimiterChar,
  isSafeReadingPath,
} from "./readingTypes";
import { RESEARCH_END, RESEARCH_START } from "./researchWriter";
import type { ReadingVault } from "./readingVault";

const READING_RESEARCH_FOLDER = "Research";

export function isValidAnnotationSourcePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (!isSafeReadingPath(normalized)) return false;
  if (hasControlOrDelimiterChar(normalized)) return false;
  const parts = normalized.split("/");
  return parts.length === 6 && parts[4] === READING_ANNOTATIONS_FOLDER;
}

function expectedResearchFolder(annotationPath: string): string {
  const parts = annotationPath.replace(/\\/g, "/").split("/");
  return `${parts.slice(0, 4).join("/")}/${READING_RESEARCH_FOLDER}`;
}

function isSafeCompanionPath(path: string, annotationPath: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.toLowerCase().endsWith(".md")) return false;
  if (hasControlOrDelimiterChar(normalized)) return false;
  if (normalized.split("/").some((part) => part === ".." || part === "." || part.length === 0)) return false;
  const folder = expectedResearchFolder(annotationPath);
  if (!normalized.startsWith(`${folder}/`)) return false;
  const basename = normalized.slice(folder.length + 1);
  return !basename.includes("/");
}

export function companionPathForAnnotation(annotationPath: string, collisionIndex = 0): string {
  if (!isValidAnnotationSourcePath(annotationPath)) {
    throw new Error("Invalid annotation source path for companion path derivation.");
  }
  const normalized = annotationPath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const basename = parts[5] ?? "";
  const bookFolder = parts.slice(0, 4).join("/");
  if (collisionIndex <= 0) {
    return `${bookFolder}/${READING_RESEARCH_FOLDER}/${basename}`;
  }
  const stem = basename.replace(/\.md$/i, "");
  return `${bookFolder}/${READING_RESEARCH_FOLDER}/${stem} · ${collisionIndex + 1}.md`;
}

function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 .,_-]*$/.test(value) && !["true", "false", "null"].includes(value.toLowerCase())
    ? value
    : JSON.stringify(value);
}

export function renderCompanionNote(annotationPath: string, annotationId: string, content: string): string {
  if (!isValidAnnotationSourcePath(annotationPath)) {
    throw new Error("Invalid annotation source path for companion note rendering.");
  }
  if (!annotationId.trim()) {
    throw new Error("Companion note requires a non-empty annotation_id.");
  }
  if (!content.trim()) {
    throw new Error("Companion note requires non-empty research content.");
  }
  const link = `[[${annotationPath.replace(/\\/g, "/").replace(/\.md$/i, "")}]]`;
  const fm = [
    "type: mindmap-reading-research",
    `source: ${yamlScalar(link)}`,
    `annotation_id: ${yamlScalar(annotationId)}`,
  ].join("\n");
  return `---\n${fm}\n---\n${content}\n`;
}

function readFrontmatterValue(text: string, key: string): string | undefined {
  if (!text.startsWith("---")) return undefined;
  const lines = text.split("\n");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return undefined;
  const line = lines.slice(1, end).find((candidate) => new RegExp(`^${key}\\s*:`).test(candidate));
  if (!line) return undefined;
  const raw = line.replace(new RegExp(`^${key}\\s*:`), "").trim();
  return raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1") || undefined;
}

async function ensureVaultFolders(vault: ReadingVault, filePath: string): Promise<void> {
  const parts = filePath.split("/");
  for (let index = 1; index < parts.length - 1; index += 1) {
    const folderPath = parts.slice(0, index + 1).join("/");
    if (!vault.get(folderPath)) {
      await vault.createFolder(folderPath);
    }
  }
}

export interface CompanionWriteResult {
  action: "created" | "updated" | "unchanged";
  companionPath: string;
}

export interface CompanionWriteOptions {
  annotationPath: string;
  annotationId: string;
  content: string;
  storedCompanionPath?: string;
}

async function readFileContent(vault: ReadingVault, entry: ReturnType<ReadingVault["get"]>): Promise<string | null> {
  if (!entry) return null;
  try {
    return await vault.read(entry);
  } catch {
    return null;
  }
}

export async function writeCompanionNote(
  vault: ReadingVault,
  options: CompanionWriteOptions,
): Promise<CompanionWriteResult> {
  if (!isValidAnnotationSourcePath(options.annotationPath)) {
    throw new Error("Invalid annotation source path for companion note.");
  }
  if (!options.annotationId.trim()) {
    throw new Error("Companion note requires a non-empty annotation_id.");
  }
  if (!options.content.trim()) {
    throw new Error("Companion note requires non-empty research content.");
  }

  if (options.storedCompanionPath && isSafeCompanionPath(options.storedCompanionPath, options.annotationPath)) {
    const existing = vault.get(options.storedCompanionPath);
    if (existing) {
      const text = await readFileContent(vault, existing);
      if (text !== null && readFrontmatterValue(text, "annotation_id") === options.annotationId) {
        const noteText = renderCompanionNote(options.annotationPath, options.annotationId, options.content);
        if (noteText === text) {
          return { action: "unchanged", companionPath: options.storedCompanionPath };
        }
        await vault.modify(existing, noteText);
        return { action: "updated", companionPath: options.storedCompanionPath };
      }
    }
  }

  let collisionIndex = 0;
  while (collisionIndex < 100) {
    const candidate = companionPathForAnnotation(options.annotationPath, collisionIndex);
    const existing = vault.get(candidate);
    if (!existing) {
      await ensureVaultFolders(vault, candidate);
      const noteText = renderCompanionNote(options.annotationPath, options.annotationId, options.content);
      await vault.create(candidate, noteText);
      return { action: "created", companionPath: candidate };
    }
    const text = await readFileContent(vault, existing);
    if (text === null) {
      collisionIndex += 1;
      continue;
    }
    if (readFrontmatterValue(text, "annotation_id") === options.annotationId) {
      const noteText = renderCompanionNote(options.annotationPath, options.annotationId, options.content);
      if (noteText === text) {
        return { action: "unchanged", companionPath: candidate };
      }
      await vault.modify(existing, noteText);
      return { action: "updated", companionPath: candidate };
    }
    collisionIndex += 1;
  }
  throw new Error("Too many companion path collisions.");
}

export interface LegacyExtractionResult {
  annotationText: string;
  companionContent: string;
}

export function extractLegacyInlineResearch(text: string): LegacyExtractionResult | null {
  const startPositions: number[] = [];
  const endPositions: number[] = [];
  let searchFrom = 0;
  while (true) {
    const pos = text.indexOf(RESEARCH_START, searchFrom);
    if (pos < 0) break;
    startPositions.push(pos);
    searchFrom = pos + RESEARCH_START.length;
  }
  searchFrom = 0;
  while (true) {
    const pos = text.indexOf(RESEARCH_END, searchFrom);
    if (pos < 0) break;
    endPositions.push(pos);
    searchFrom = pos + RESEARCH_END.length;
  }

  if (startPositions.length === 0 && endPositions.length === 0) return null;
  if (startPositions.length !== 1 || endPositions.length !== 1) {
    throw new Error("Managed research markers are incomplete or duplicated.");
  }
  const startIdx = startPositions[0];
  const endIdx = endPositions[0];
  if (endIdx < startIdx + RESEARCH_START.length) {
    throw new Error("Managed research markers are in the wrong order.");
  }

  const afterEnd = endIdx + RESEARCH_END.length;
  const annotationText = text.slice(0, startIdx) + text.slice(afterEnd);

  const blockRaw = text.slice(startIdx + RESEARCH_START.length, endIdx);
  const blockNormalized = blockRaw.replace(/\r\n/g, "\n");
  const lines = blockNormalized.split("\n");

  let firstNonblank = 0;
  while (firstNonblank < lines.length && lines[firstNonblank]?.trim() === "") firstNonblank++;
  const hasStructuralHeading = lines[firstNonblank]?.trim() === "## Research";

  let strippedResearch = false;
  let convertedSources = false;
  const cleaned: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (hasStructuralHeading && !strippedResearch && i === firstNonblank && trimmed === "## Research") {
      strippedResearch = true;
      continue;
    }
    if (hasStructuralHeading && !convertedSources && trimmed === "### Sources") {
      convertedSources = true;
      cleaned.push("## Sources");
      continue;
    }
    cleaned.push(lines[i]);
  }

  let start = 0;
  while (start < cleaned.length && cleaned[start]?.trim() === "") start++;
  let end = cleaned.length;
  while (end > start && cleaned[end - 1]?.trim() === "") end--;
  const companionContent = cleaned.slice(start, end).join("\n");

  if (!companionContent) {
    throw new Error("Legacy research block contains no usable content.");
  }

  return { annotationText, companionContent };
}
