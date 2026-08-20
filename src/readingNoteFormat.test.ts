import test from "node:test";
import assert from "node:assert/strict";

import {
  conceptWikilink,
  conceptWikilinks,
  deriveHumanTitle,
  humanTitleCandidate,
  relatedNoteWikilink,
  relatedNoteWikilinks,
  renderLeadingBlockquote,
  replaceLeadingAnnotationSource,
} from "./readingNoteFormat";
import { READING_SOURCE_END, READING_SOURCE_START, type AppleBooksAnnotation } from "./readingTypes";

function annotation(overrides: Partial<AppleBooksAnnotation> = {}): AppleBooksAnnotation {
  return {
    annotation_id: "aeannotation:1",
    quote: "And behavior is hard to teach, even to really smart people.",
    book_title: "A Book",
    ...overrides,
  };
}

test("derives the documented sample title from the quote", () => {
  assert.equal(deriveHumanTitle(annotation()), "Behavior is hard to teach");
});

test("strips a single leading stopword before extracting the phrase", () => {
  assert.equal(deriveHumanTitle(annotation({ quote: "But small steps compound eventually." })), "Small steps compound eventually");
  assert.equal(deriveHumanTitle(annotation({ quote: "So we tend to underestimate, always." })), "We tend to underestimate");
});

test("strips markdown and smart-quote noise without over-trimming the phrase", () => {
  assert.equal(deriveHumanTitle(annotation({ quote: "**“Small steps compound.”**" })), "Small steps compound");
  assert.equal(deriveHumanTitle(annotation({ quote: "> _Ideas are cheap_, execution is not." })), "Ideas are cheap");
});

test("preserves Unicode letters and emoji while still bounding to a safe title", () => {
  assert.equal(deriveHumanTitle(annotation({ quote: "Café résilience: être présent." })), "Café résilience");
  assert.equal(deriveHumanTitle(annotation({ quote: "📚 Reading is joyful, truly." })), "📚 Reading is joyful");
});

test("falls back through user note, chapter, location, then Annotation", () => {
  assert.equal(deriveHumanTitle(annotation({ quote: "", user_note: "Revisit this idea next week." })), "Revisit this idea next week");
  assert.equal(deriveHumanTitle(annotation({ quote: "", chapter: "Chapter 3: The Long Game" })), "Chapter 3");
  assert.equal(deriveHumanTitle(annotation({ quote: "", location: "Location 4210" })), "Location 4210");
  assert.equal(deriveHumanTitle(annotation({ quote: "", user_note: "", chapter: "", location: "" })), "Annotation");
  assert.equal(deriveHumanTitle(annotation({ quote: "...", user_note: "***" })), "Annotation");
});

test("falls through reserved-name and dot-only candidates using existing path-safety rules", () => {
  assert.equal(deriveHumanTitle(annotation({ quote: "CON" })), "CON-");
  assert.equal(deriveHumanTitle(annotation({ quote: "...", user_note: "Still worth remembering" })), "Still worth remembering");
});

test("bounds an unpunctuated, very long quote to a safe title length", () => {
  const longQuote = Array.from({ length: 80 }, (_, index) => `word${index}`).join(" ");
  const title = deriveHumanTitle(annotation({ quote: longQuote }));
  assert.ok(title.length <= 80);
  assert.ok(title.length > 0);
});

test("generates deterministic collision candidates with no date or ID", () => {
  const title = "Behavior is hard to teach";
  assert.equal(humanTitleCandidate(title), "Behavior is hard to teach.md");
  assert.equal(humanTitleCandidate(title, 0), "Behavior is hard to teach.md");
  assert.equal(humanTitleCandidate(title, 1), "Behavior is hard to teach · 2.md");
  assert.equal(humanTitleCandidate(title, 2), "Behavior is hard to teach · 3.md");
});

test("renders a leading blockquote for the quote alone", () => {
  assert.equal(
    renderLeadingBlockquote({ quote: "And behavior is hard to teach, even to really smart people." }),
    "> And behavior is hard to teach, even to really smart people.",
  );
});

test("renders a multiline quote and an Apple user note separated by a blank quoted line", () => {
  const rendered = renderLeadingBlockquote({
    quote: "Line one\nLine two",
    user_note: "Note line one\nNote line two",
  });
  assert.equal(rendered, "> Line one\n> Line two\n>\n> Note line one\n> Note line two");
  assert.equal(/^#|callout|<!--/.test(rendered), false);
});

test("replaces an old marker block using the body's CRLF convention, with no mixed line endings", () => {
  const body = [
    READING_SOURCE_START,
    "## Apple Books Source",
    "> **Quote**",
    "> old quote",
    READING_SOURCE_END,
    "Rest of body",
    "Second line",
    "",
  ].join("\r\n");
  const result = replaceLeadingAnnotationSource(body, { quote: "New quote text." });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, "> New quote text.\r\nRest of body\r\nSecond line\r\n");
    assert.equal(result.text.includes(READING_SOURCE_START), false);
    assert.equal(/[^\r]\n/.test(result.text), false);
  }
});

test("replaces an existing leading blockquote and preserves LF-terminated trailing content", () => {
  const body = "> old quote\n>\n> old note\n\nRest content\nMore content\n";
  const result = replaceLeadingAnnotationSource(body, { quote: "New quote." });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, "> New quote.\n\nRest content\nMore content\n");
  }
});

test("treats blank lines before an existing leading blockquote as formatting, not user content", () => {
  const body = "\n\n> old quote\n\nRest content\n";
  const result = replaceLeadingAnnotationSource(body, { quote: "New quote." });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, "> New quote.\n\nRest content\n");
    assert.equal(result.text.startsWith("> New quote."), true);
  }
});

test("prepends a blockquote to a body with no existing managed region", () => {
  const result = replaceLeadingAnnotationSource("Freeform note content.\n", { quote: "New quote." });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, "> New quote.\n\nFreeform note content.\n");
  }
});

test("refuses to overwrite an incomplete old marker block instead of silently discarding content", () => {
  const body = `${READING_SOURCE_START}\nsome content without an end marker`;
  const result = replaceLeadingAnnotationSource(body, { quote: "New quote." });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "incomplete-managed-source-markers");
  }
});

test("refuses an orphan end marker with no preceding start marker", () => {
  const body = `Some preface content\n${READING_SOURCE_END}\nrest of note`;
  const result = replaceLeadingAnnotationSource(body, { quote: "New quote." });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "incomplete-managed-source-markers");
  }
});

test("renders readable concept wikilinks and deduplicates them", () => {
  assert.equal(conceptWikilink("Behavior change"), "[[Behavior change]]");
  assert.deepEqual(conceptWikilinks(["Behavior change", "Teaching", "Behavior change"]), ["[[Behavior change]]", "[[Teaching]]"]);
});

test("renders readable related wikilinks with the filename as label and strips the extension", () => {
  const path = "Books/Apple Books/Michael Gervais/The First Rule of Mastery/Annotations/Overcoming ingrained habits.md";
  assert.equal(
    relatedNoteWikilink(path),
    "[[Books/Apple Books/Michael Gervais/The First Rule of Mastery/Annotations/Overcoming ingrained habits|Overcoming ingrained habits]]",
  );
  assert.equal(relatedNoteWikilink(`${path.slice(0, -3)}.MD`), relatedNoteWikilink(path));
});

test("keeps a valid related target with spaces and Unicode byte-accurate", () => {
  const path = "Books/Apple Books/Café Résilience/Être Présent/Annotations/Café note 📚.md";
  assert.equal(relatedNoteWikilink(path), `[[${path.slice(0, -3)}|Café note 📚]]`);
});

test("allows a safe ordinary vault note outside Books/Apple Books", () => {
  const path = "Notes/Behavior change.md";
  assert.equal(relatedNoteWikilink(path), "[[Notes/Behavior change|Behavior change]]");
});

test("rejects a traversal related target", () => {
  assert.equal(relatedNoteWikilink("Books/Apple Books/Author/../../etc/passwd.md"), undefined);
});

test("rejects an absolute related target", () => {
  assert.equal(relatedNoteWikilink("/Books/Apple Books/Author/Book/Annotations/Note.md"), undefined);
});

test("rejects a related target that points inside .obsidian", () => {
  assert.equal(relatedNoteWikilink("Books/Apple Books/.obsidian/Note.md"), undefined);
});

test("rejects a related target containing a control character", () => {
  assert.equal(relatedNoteWikilink("Books/Apple Books/Author/Book/Annotations/Note.md"), undefined);
});

test("rejects related targets that would inject wikilink delimiters", () => {
  assert.equal(relatedNoteWikilink("Books/Apple Books/Author/Book/Annotations/Note]].md"), undefined);
  assert.equal(relatedNoteWikilink("Books/Apple Books/Author/Book/Annotations/Note|evil.md"), undefined);
  assert.equal(relatedNoteWikilink("Books/Apple Books/Author/Book/Annotations/[Note].md"), undefined);
});

test("deduplicates related wikilinks by resolved target", () => {
  const path = "Books/Apple Books/Author/Book/Annotations/Same note.md";
  assert.deepEqual(relatedNoteWikilinks([path, path]), [relatedNoteWikilink(path)]);
});

test("omits invalid related targets from the list helper deterministically, keeping valid ones", () => {
  const valid = "Books/Apple Books/Author/Book/Annotations/Valid note.md";
  const paths = [
    "Books/Apple Books/Author/../../etc/passwd.md",
    valid,
    "/Books/Apple Books/Author/Book/Annotations/Absolute.md",
    "Books/Apple Books/Author/Book/Annotations/Bad]].md",
  ];
  assert.deepEqual(relatedNoteWikilinks(paths), [relatedNoteWikilink(valid)]);
});
