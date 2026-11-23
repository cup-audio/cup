import { escapeHtmlAttribute } from "#src/html-escaping.ts";

export const SYNCHRONIZATION_UNIT_ATTRIBUTE = "data-synchronization-unit";

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

export function serializeUnitAttribute(unitId: string): string {
  return ` ${SYNCHRONIZATION_UNIT_ATTRIBUTE}="${escapeHtmlAttribute(unitId)}"`;
}

export function wrapInScrollCard(html: string): string {
  return `<div data-scroll-card="">${html}</div>`;
}
