import { EngineError } from "./errors";

const MAX_CHUNK_INPUT_CHARS = 2_500_000;

export interface MetadataChunk {
  text: string;
  /** Exact source body region represented by this chunk; synthetic context is excluded. */
  sourceText: string;
  headingBreadcrumb: string;
  /** Optional synthetic fence context used only in provider prompts. */
  fenceContext?: string;
}

interface Block {
  type: "heading" | "content";
  text: string;
  level?: number;
  fenced?: boolean;
  fenceHeader?: string;
}

interface HeadingEntry {
  level: number;
  line: string;
}

export function chunkMarkdown(body: string, maxChunkBytes: number): MetadataChunk[] {
  if (body.length > MAX_CHUNK_INPUT_CHARS) {
    throw new EngineError("METADATA_CONFIG_INVALID", "Metadata chunker input exceeds the maximum bounded character length.", { length: body.length });
  }
  if (maxChunkBytes <= 0) {
    throw new EngineError("METADATA_CONFIG_INVALID", "maxChunkBytes must be a positive integer.");
  }
  if (body.trim().length === 0) return [];

  const blocks = splitBlocks(body);
  const headingStack: HeadingEntry[] = [];
  const chunks: MetadataChunk[] = [];
  let pendingParts: string[] = [];
  let pendingBytes = 0;
  let breadcrumb = "";

  function bodyBudget(): number {
    const budget = maxChunkBytes - Buffer.byteLength(breadcrumb, "utf8");
    if (budget <= 0) {
      throw new EngineError("METADATA_CONFIG_INVALID", "Heading breadcrumb consumes the entire chunk budget.");
    }
    return budget;
  }

  function flush(): void {
    if (pendingParts.length === 0) return;
    const text = pendingParts.join("\n\n");
    chunks.push({ text, sourceText: text, headingBreadcrumb: breadcrumb });
    pendingParts = [];
    pendingBytes = 0;
  }

  for (const block of blocks) {
    if (block.type === "heading") {
      flush();
      const level = block.level!;
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, line: block.text });
      breadcrumb = headingStack.map(h => h.line).join(" > ");
      continue;
    }

    const budget = bodyBudget();
    const blockBytes = Buffer.byteLength(block.text, "utf8");

    if (blockBytes > budget) {
      flush();
      const pieces: FencePiece[] = block.fenced
        ? splitFencedBlock(block.text, budget, block.fenceHeader!)
        : splitOversizedText(block.text, budget).map((text) => ({ text, sourceText: text }));
      for (const piece of pieces) {
        chunks.push({ text: piece.text, sourceText: piece.sourceText, headingBreadcrumb: breadcrumb, fenceContext: piece.fenceContext });
      }
      continue;
    }

    const sepBytes = pendingParts.length > 0 ? 2 : 0;
    if (pendingBytes + sepBytes + blockBytes > budget && pendingParts.length > 0) {
      flush();
    }
    pendingParts.push(block.text);
    pendingBytes += (pendingParts.length > 1 ? 2 : 0) + blockBytes;
  }
  flush();

  for (const chunk of chunks) {
    const total = Buffer.byteLength(chunk.sourceText, "utf8") + Buffer.byteLength(chunk.headingBreadcrumb, "utf8") + Buffer.byteLength(chunk.fenceContext ?? "", "utf8");
    if (total > maxChunkBytes) {
      throw new EngineError("METADATA_CONFIG_INVALID", `Internal: emitted chunk exceeds budget (${total} > ${maxChunkBytes}).`);
    }
  }

  return chunks;
}

const FENCED_CODE_OPEN = /^(`{3,}|~{3,})/;

function isFenceClose(line: string, marker: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < marker.length) return false;
  const ch = marker[0];
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== ch) return false;
  }
  return true;
}

function splitBlocks(body: string): Block[] {
  const lines = body.split("\n");
  const blocks: Block[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  let fenceOpenLine = "";

  function flushContent(): void {
    if (current.length === 0) return;
    const text = current.join("\n");
    if (text.trim().length > 0) {
      blocks.push({ type: "content", text });
    }
    current = [];
  }

  function flushFenced(): void {
    if (current.length === 0) return;
    blocks.push({ type: "content", text: current.join("\n"), fenced: true, fenceHeader: fenceOpenLine });
    current = [];
  }

  for (const line of lines) {
    if (inFence) {
      current.push(line);
      if (isFenceClose(line, fenceMarker)) {
        inFence = false;
        flushFenced();
      }
      continue;
    }

    const fenceMatch = FENCED_CODE_OPEN.exec(line);
    if (fenceMatch) {
      flushContent();
      inFence = true;
      fenceMarker = fenceMatch[1][0].repeat(fenceMatch[1].length);
      fenceOpenLine = line;
      current.push(line);
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushContent();
      blocks.push({ type: "heading", text: line.trim(), level: headingMatch[1].length });
      continue;
    }

    if (line.trim() === "") {
      flushContent();
      continue;
    }

    current.push(line);
  }

  if (inFence) {
    flushFenced();
  } else {
    flushContent();
  }

  return blocks;
}

interface FencePiece {
  text: string;
  sourceText: string;
  fenceContext?: string;
}

function splitFencedBlock(text: string, maxBytes: number, fenceHeader: string): FencePiece[] {
  const lines = text.split("\n");
  if (lines.length <= 2) return splitOversizedText(text, maxBytes).map((piece) => ({ text: piece, sourceText: piece }));

  const openLine = lines[0];
  const lastLine = lines[lines.length - 1];
  const hasClose = isFenceClose(lastLine, fenceHeader.replace(/[^`~]/g, "").slice(0, 1).repeat(fenceHeader.match(FENCED_CODE_OPEN)?.[1].length ?? 3));
  const closeLine = hasClose ? lastLine : null;
  const contentLines = closeLine ? lines.slice(1, -1) : lines.slice(1);

  if (contentLines.length === 0) return splitOversizedText(text, maxBytes).map((piece) => ({ text: piece, sourceText: piece }));

  const headerBytes = Buffer.byteLength(openLine + "\n", "utf8");
  const closeBytes = closeLine ? Buffer.byteLength("\n" + closeLine, "utf8") : 0;
  const results: FencePiece[] = [];
  let current: string[] = [];
  let currentBytes = headerBytes;

  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i];
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    const isLast = i === contentLines.length - 1;
    const reserveClose = isLast ? closeBytes : 0;

    if (currentBytes + lineBytes + reserveClose > maxBytes && current.length > 0) {
      results.push({ text: openLine + "\n" + current.join("\n"), sourceText: current.join("\n"), fenceContext: openLine });
      current = [];
      currentBytes = headerBytes;
    }
    current.push(line);
    currentBytes += lineBytes;
  }

  if (current.length > 0) {
    const piece = closeLine
      ? openLine + "\n" + current.join("\n") + "\n" + closeLine
      : openLine + "\n" + current.join("\n");
    results.push({ text: piece, sourceText: current.join("\n"), fenceContext: closeLine ? `${openLine}\n${closeLine}` : openLine });
  }

  return results.flatMap((piece) => {
    if (Buffer.byteLength(piece.text, "utf8") <= maxBytes) return [piece];
    const contextBytes = Buffer.byteLength(piece.fenceContext ?? "", "utf8");
    const sourceBudget = maxBytes - contextBytes;
    if (sourceBudget <= 0) {
      throw new EngineError("METADATA_CONFIG_INVALID", "Synthetic fence context consumes the entire chunk budget.");
    }
    return splitOversizedText(piece.sourceText, sourceBudget).map((sourceText) => ({
      text: `${piece.fenceContext ?? ""}\n${sourceText}`.trim(),
      sourceText,
      fenceContext: piece.fenceContext,
    }));
  });
}

function splitOversizedText(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];

  const sentences = splitSentences(text);
  if (sentences.length > 1) {
    const packed = packByBytes(sentences, maxBytes, " ");
    return packed.flatMap(piece =>
      Buffer.byteLength(piece, "utf8") <= maxBytes ? [piece] : splitByWords(piece, maxBytes),
    );
  }

  return splitByWords(text, maxBytes);
}

function splitByWords(text: string, maxBytes: number): string[] {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length <= 1) return hardSplitUtf8(text, maxBytes);

  const packed = packByBytes(words, maxBytes, " ");
  return packed.flatMap(piece =>
    Buffer.byteLength(piece, "utf8") <= maxBytes ? [piece] : hardSplitUtf8(piece, maxBytes),
  );
}

function splitSentences(text: string): string[] {
  const result: string[] = [];
  const pattern = /[^.!?\n]+(?:[.!?]+|\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const s = match[0].trim();
    if (s.length > 0) result.push(s);
  }
  if (result.length === 0 && text.trim().length > 0) return [text.trim()];
  return result;
}

function packByBytes(pieces: readonly string[], maxBytes: number, separator: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  const sepBytes = Buffer.byteLength(separator, "utf8");

  for (const piece of pieces) {
    const pieceBytes = Buffer.byteLength(piece, "utf8");
    const withSep = current.length > 0 ? sepBytes : 0;
    if (currentBytes + withSep + pieceBytes > maxBytes && current.length > 0) {
      chunks.push(current.join(separator));
      current = [];
      currentBytes = 0;
    }
    current.push(piece);
    currentBytes += (current.length > 1 ? sepBytes : 0) + pieceBytes;
  }
  if (current.length > 0) {
    chunks.push(current.join(separator));
  }
  return chunks;
}

function hardSplitUtf8(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let bytes = 0;
    while (end < text.length) {
      const code = text.codePointAt(end)!;
      const charLen = code > 0xffff ? 2 : 1;
      const charBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (bytes + charBytes > maxBytes) break;
      bytes += charBytes;
      end += charLen;
    }
    if (end === start) {
      end = start + (text.codePointAt(start)! > 0xffff ? 2 : 1);
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
