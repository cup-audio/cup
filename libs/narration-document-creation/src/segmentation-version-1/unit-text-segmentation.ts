import { parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";

const HEADING_TAG_NAMES = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const IGNORED_TAG_NAMES = new Set(["script", "style", "svg", "template"]);

// Unknown and custom block containers remain boundaries while their visible text is retained.
const INLINE_TAG_NAMES = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "ins",
  "kbd",
  "label",
  "mark",
  "q",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
  "wbr",
]);

const MAX_UNIT_TEXT_CHARACTERS = 2_000;

/** The narration text of one synchronization unit, within the narration synthesis limit. */
export type UnitText = {
  text: string;
};

/** Divides selected HTML into ordered unit texts, joining headings to the following text. */
export function segmentUnitTexts(html: string): UnitText[] {
  const documentFragment = parseFragment(html);
  const unitTexts: UnitText[] = [];
  const pendingHeadings: string[] = [];

  visitNarrationElements(documentFragment, {
    addNarrationText(text) {
      const normalizedText = normalizeNarrationText(text);

      if (normalizedText.length === 0) {
        return;
      }

      const unitText = [...pendingHeadings, normalizedText].join("\n\n");

      pendingHeadings.length = 0;

      for (const unitTextPart of splitNarrationBlock(unitText)) {
        unitTexts.push({ text: unitTextPart });
      }
    },
    addPendingHeading(text) {
      const normalizedText = normalizeNarrationText(text);

      if (normalizedText.length > 0) {
        pendingHeadings.push(normalizedText);
      }
    },
  });

  if (pendingHeadings.length > 0) {
    for (const text of splitNarrationBlock(pendingHeadings.join("\n\n"))) {
      unitTexts.push({ text });
    }
  }

  return unitTexts;
}

type ElementVisitor = {
  addNarrationText(text: string): void;
  addPendingHeading(text: string): void;
};

/** Visits visible text in document order, flushing direct text around nested block boundaries. */
function visitNarrationElements(
  parentNode: DefaultTreeAdapterMap["parentNode"],
  visitor: ElementVisitor,
): void {
  const textParts: string[] = [];

  function flushTextParts(): void {
    visitor.addNarrationText(textParts.join(""));
    textParts.length = 0;
  }

  for (const childNode of parentNode.childNodes) {
    if ("value" in childNode) {
      textParts.push(childNode.value.replace(/[\t\n\f\r ]+/gu, " "));
      continue;
    }

    if (!("tagName" in childNode) || IGNORED_TAG_NAMES.has(childNode.tagName)) {
      continue;
    }

    if (HEADING_TAG_NAMES.has(childNode.tagName)) {
      flushTextParts();
      visitor.addPendingHeading(extractText(childNode));
      continue;
    }

    if (childNode.tagName === "p") {
      flushTextParts();
      visitor.addNarrationText(extractText(childNode));
      continue;
    }

    if (childNode.tagName === "li") {
      flushTextParts();
      visitNarrationElements(childNode, visitor);
      continue;
    }

    if (childNode.tagName === "br") {
      textParts.push("\n");
      continue;
    }

    if (INLINE_TAG_NAMES.has(childNode.tagName)) {
      textParts.push(extractText(childNode));
      continue;
    }

    flushTextParts();
    visitNarrationElements(childNode, visitor);
  }

  flushTextParts();
}

function extractText(parentNode: DefaultTreeAdapterMap["parentNode"]): string {
  const textParts: string[] = [];

  for (const childNode of parentNode.childNodes) {
    if ("value" in childNode) {
      textParts.push(childNode.value.replace(/[\t\n\f\r ]+/gu, " "));
      continue;
    }

    if (!("tagName" in childNode) || IGNORED_TAG_NAMES.has(childNode.tagName)) {
      continue;
    }

    if (childNode.tagName === "br") {
      textParts.push("\n");
      continue;
    }

    textParts.push(extractText(childNode));
  }

  return textParts.join("");
}

// Text-node whitespace is already collapsed; remaining newlines represent explicit breaks.
function normalizeNarrationText(text: string): string {
  return text
    .replace(/\u00a0/gu, " ")
    .replace(/[\t\f\r ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n+/gu, "\n")
    .trim();
}

/** Splits oversized narration at sentences, falling back to word boundaries when necessary. */
function splitNarrationBlock(text: string): string[] {
  if (text.length <= MAX_UNIT_TEXT_CHARACTERS) {
    return [text];
  }

  const sentenceBoundaryPattern = /(?<=[.!?])\s+|(?<=[。！？])(?![。！？])\s*/gu;
  const sentences: Array<{ separatorBefore: string; text: string }> = [];
  let sentenceStart = 0;
  let separatorBefore = "";

  for (const sentenceBoundaryMatch of text.matchAll(sentenceBoundaryPattern)) {
    const sentenceEnd = sentenceBoundaryMatch.index;

    sentences.push({ separatorBefore, text: text.slice(sentenceStart, sentenceEnd) });
    separatorBefore = sentenceBoundaryMatch[0];
    sentenceStart = sentenceEnd + separatorBefore.length;
  }

  if (sentenceStart < text.length) {
    sentences.push({ separatorBefore, text: text.slice(sentenceStart) });
  }

  const unitTexts: string[] = [];
  let currentPart = "";

  for (const sentence of sentences) {
    for (const [sentencePartIndex, sentencePart] of splitTextAtWordBoundaries(
      sentence.text,
    ).entries()) {
      const sentencePartSeparator = sentencePartIndex === 0 ? sentence.separatorBefore : " ";
      const combinedPart =
        currentPart.length === 0
          ? sentencePart
          : `${currentPart}${sentencePartSeparator}${sentencePart}`;

      if (combinedPart.length <= MAX_UNIT_TEXT_CHARACTERS) {
        currentPart = combinedPart;
        continue;
      }

      unitTexts.push(currentPart);
      currentPart = sentencePart;
    }
  }

  if (currentPart.length > 0) {
    unitTexts.push(currentPart);
  }

  return unitTexts;
}

/** Splits oversized sentences at whitespace before falling back to hard text boundaries. */
function splitTextAtWordBoundaries(text: string): string[] {
  if (text.length <= MAX_UNIT_TEXT_CHARACTERS) {
    return [text];
  }

  const parts: string[] = [];
  let currentPart = "";
  const wordSeparators = text.match(/\s+/gu) ?? [];

  for (const [wordIndex, word] of text.split(/\s+/u).entries()) {
    if (word.length > MAX_UNIT_TEXT_CHARACTERS) {
      if (currentPart.length > 0) {
        parts.push(currentPart);
        currentPart = "";
      }

      parts.push(...splitUnbrokenText(word));
      continue;
    }

    const wordSeparator = wordIndex === 0 ? "" : (wordSeparators[wordIndex - 1] ?? " ");
    const combinedPart = currentPart.length === 0 ? word : `${currentPart}${wordSeparator}${word}`;

    if (combinedPart.length <= MAX_UNIT_TEXT_CHARACTERS) {
      currentPart = combinedPart;
      continue;
    }

    parts.push(currentPart);
    currentPart = word;
  }

  if (currentPart.length > 0) {
    parts.push(currentPart);
  }

  return parts;
}

// Avoid splitting UTF-16 surrogate pairs when no natural boundary is available.
function splitUnbrokenText(text: string): string[] {
  const parts: string[] = [];
  let currentPart = "";

  for (const character of text) {
    if (currentPart.length + character.length > MAX_UNIT_TEXT_CHARACTERS) {
      parts.push(currentPart);
      currentPart = "";
    }

    currentPart += character;
  }

  if (currentPart.length > 0) {
    parts.push(currentPart);
  }

  return parts;
}
