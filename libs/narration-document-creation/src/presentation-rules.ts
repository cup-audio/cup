import { escapeHtmlAttribute } from "#src/html-escaping.ts";

// The presentation rules that both rendering paths share: the spec's "Presentation rules" of the
// narration document (https://github.com/cup-audio/cup/issues/493).

/** Marks every element that belongs to a synchronization unit with the unit's ID. */
export const SYNCHRONIZATION_UNIT_ATTRIBUTE = "data-synchronization-unit";

/** Inline elements shown as themselves, with every attribute stripped; links are kept separately. */
export const KEPT_INLINE_TAG_NAMES = new Set([
  "b",
  "br",
  "code",
  "del",
  "em",
  "i",
  "kbd",
  "q",
  "s",
  "samp",
  "strong",
  "sub",
  "sup",
  "var",
]);

/**
 * Inline elements flattened to their text. Every other element that is neither kept nor a link is a
 * block, which inside a table cell, term or description is flattened with a space on either side.
 */
export const FLATTENED_INLINE_TAG_NAMES = new Set([
  "abbr",
  "bdi",
  "bdo",
  "cite",
  "data",
  "dfn",
  "ins",
  "label",
  "mark",
  "ruby",
  "small",
  "span",
  "time",
  "u",
  "wbr",
]);

/** Serializes the unit attribute of the unit with the given ID. */
export function serializeUnitAttribute(unitId: string): string {
  return ` ${SYNCHRONIZATION_UNIT_ATTRIBUTE}="${escapeHtmlAttribute(unitId)}"`;
}

/**
 * Wraps a `table` or `pre` in the element that the reader styles as a scrolling card, so a wide
 * block never widens the page. The wrapper carries no unit attribute.
 */
export function wrapInScrollCard(html: string): string {
  return `<div data-scroll-card="">${html}</div>`;
}
