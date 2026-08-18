import { RESEARCH_END, RESEARCH_START } from "./researchWriter";

export function prepareActiveNoteResearchInput(text: string, limit: number): string {
  let body = text;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end >= 0) body = body.slice(end + 4);
  }
  const start = body.indexOf(RESEARCH_START);
  const end = start >= 0 ? body.indexOf(RESEARCH_END, start) : -1;
  if (start >= 0 && end >= 0) body = `${body.slice(0, start)}${body.slice(end + RESEARCH_END.length)}`;
  return body.replace(/<!-- mindmap:apple-books-(?:source:start|source:end) -->/g, "").trim().slice(0, limit);
}
