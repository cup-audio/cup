import type { DefaultTreeAdapterMap } from "parse5";

import { CupError } from "@cup/errors";

import { segmentUnitTexts } from "#src/segmentation-version-1/unit-text-segmentation.ts";
import type { NarrationBlock, UnitRange } from "#src/segmentation.ts";

// Segmentation version 1 is frozen: its golden fixtures fail on any change to its units, and a
// change to them must become a new segmentation version. That is why it keeps its own copy of the
// element classification instead of sharing presentation's, which may change at any time.

const EXCLUDED_TAG_NAMES = new Set([
  "audio",
  "canvas",
  "embed",
  "iframe",
  "img",
  "noscript",
  "object",
  "picture",
  "script",
  "source",
  "style",
  "svg",
  "template",
  "track",
  "video",
]);

const HEADING_TAG_NAMES = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const STRUCTURAL_TAG_NAMES = new Set(["blockquote", "li", "ol", "p", "ul"]);

const INLINE_TAG_NAMES = new Set(["a", "br", "code", "em", "strong"]);

const FLATTENED_INLINE_TAG_NAMES = new Set([
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "data",
  "del",
  "dfn",
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
  "sub",
  "sup",
  "time",
  "u",
  "var",
  "wbr",
]);

const NARRATION_ELEMENT_SEPARATOR = "\n\n";

type SourceElement = DefaultTreeAdapterMap["element"];
type SourceChildNode = DefaultTreeAdapterMap["childNode"];

// Nodes that segmentation creates itself, such as normalized line breaks, have no source node.
type SafeText = { type: "text"; value: string; source?: SourceChildNode };
type SafeBoundary = { type: "boundary"; children: readonly SafeNode[] };
// A flattened inline element; units treat its content as if it stood in its parent's place.
type SafeFlattened = { type: "flattened"; children: readonly SafeNode[]; source: SourceElement };
type SafeElement = {
  type: "element";
  tagName: string;
  children: readonly SafeNode[];
  source?: SourceElement;
};
type SafeNode = SafeBoundary | SafeElement | SafeFlattened | SafeText;
type PendingHeading = { element: SafeElement; block: NarrationBlock };
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const LINE_BREAK: SafeElement = { type: "element", tagName: "br", children: [] };

/**
 * Divides narration source material into synchronization units with segmentation version 1's rules:
 * every table cell, `caption`, `dt` and `dd` is its own unit, `pre` collapses whitespace and is
 * split mid-line past 2,000 characters, and a heading before a container joins the container's
 * first unit.
 */
export function segmentWithVersion1({
  sourceTitle,
  sourceSubtitle,
  sourceMaterial,
}: {
  sourceTitle: string;
  sourceSubtitle?: string | undefined;
  sourceMaterial: DefaultTreeAdapterMap["documentFragment"];
}): {
  sourceTitle: string;
  sourceSubtitle?: string;
  unitRanges: readonly UnitRange[];
} {
  const normalizedSourceTitle = normalizeNarrationText(sourceTitle);
  const comparableSourceTitle = normalizeComparableNarrationText(sourceTitle);

  if (normalizedSourceTitle.length === 0) {
    throw new CupError("Expected the source title to contain narration text");
  }

  const normalizedSourceSubtitle =
    sourceSubtitle === undefined ? undefined : normalizeNarrationText(sourceSubtitle);

  if (normalizedSourceSubtitle?.length === 0) {
    throw new CupError("Expected the source subtitle to contain narration text");
  }

  const safeNodes = sanitizeChildren(sourceMaterial);
  const unitRanges: UnitRange[] = [];
  const pendingHeadings: PendingHeading[] = [];
  let hasSkippedEquivalentSourceHeading = false;

  function addSynchronizationUnit(
    narrationText: string,
    range: DistributiveOmit<UnitRange, "synchronizationUnit">,
  ): void {
    const id = createSynchronizationUnitId(unitRanges.length);

    unitRanges.push({ ...range, synchronizationUnit: { id, narrationText } });
  }

  function addBodyUnits(
    narrationElements: readonly SafeElement[],
    blocks: readonly NarrationBlock[],
  ): void {
    const unitTexts = segmentUnitTexts(narrationElements.map(serializeSafeNode).join("")).map(
      ({ text }) => text,
    );

    // A block without text keeps the pending headings for the next block.
    if (unitTexts.length === 0) {
      return;
    }

    pendingHeadings.length = 0;

    if (unitTexts.length === 1) {
      addSynchronizationUnit(unitTexts[0]!, { type: "body", blocks });
      return;
    }

    const combinedNarrationText = narrationElements
      .map((narrationElement) => normalizeNarrationText(extractSafeText(narrationElement.children)))
      .join(NARRATION_ELEMENT_SEPARATOR);
    let unitTextSearchStart = 0;

    for (const unitText of unitTexts) {
      const unitTextStart = combinedNarrationText.indexOf(unitText, unitTextSearchStart);

      if (unitTextStart < 0) {
        throw new CupError("Expected every unit text to occur in its source block");
      }

      const unitTextEnd = unitTextStart + unitText.length;

      addSynchronizationUnit(unitText, {
        type: "body",
        blocks,
        textRange: { start: unitTextStart, end: unitTextEnd },
      });
      unitTextSearchStart = unitTextEnd;
    }
  }

  function visitNodes(nodes: readonly SafeNode[]): void {
    let directContent: SafeNode[] = [];

    function flushDirectContent(): void {
      if (normalizeNarrationText(extractSafeText(directContent)).length > 0) {
        addNarrationBlock(
          { type: "element", tagName: "p", children: directContent },
          { type: "inline-run", nodes: directContent.map(getSourceNode) },
        );
      }

      directContent = [];
    }

    for (const node of expandFlattenedBlockContent(nodes)) {
      if (node.type === "text" || node.type === "flattened") {
        directContent.push(node);
        continue;
      }

      if (node.type === "boundary") {
        flushDirectContent();
        visitNodes(node.children);
        continue;
      }

      if (INLINE_TAG_NAMES.has(node.tagName)) {
        directContent.push(node);
        continue;
      }

      if (HEADING_TAG_NAMES.has(node.tagName)) {
        flushDirectContent();

        const normalizedHeading = normalizeSafeElement(node);
        const headingText = normalizeNarrationText(extractSafeText(normalizedHeading.children));

        if (headingText.length === 0) {
          continue;
        }

        if (
          !hasSkippedEquivalentSourceHeading &&
          normalizeComparableNarrationText(headingText) === comparableSourceTitle
        ) {
          hasSkippedEquivalentSourceHeading = true;
          continue;
        }

        pendingHeadings.push({
          element: normalizedHeading,
          block: { type: "element", element: getSourceElement(node) },
        });
        continue;
      }

      if (node.tagName === "p") {
        flushDirectContent();
        addNarrationBlock(node, { type: "element", element: getSourceElement(node) });
        continue;
      }

      flushDirectContent();
      visitNodes(node.children);
    }

    flushDirectContent();
  }

  function addNarrationBlock(element: SafeElement, block: NarrationBlock): void {
    addBodyUnits(
      [
        ...pendingHeadings.map((pendingHeading) => pendingHeading.element),
        normalizeSafeElement(element),
      ],
      [...pendingHeadings.map((pendingHeading) => pendingHeading.block), block],
    );
  }

  addSynchronizationUnit(normalizedSourceTitle, { type: "source-title" });

  if (normalizedSourceSubtitle !== undefined) {
    // Added before any body block, so the source subtitle never absorbs a pending heading.
    addSynchronizationUnit(normalizedSourceSubtitle, { type: "source-subtitle" });
  }

  visitNodes(safeNodes);

  if (pendingHeadings.length > 0) {
    const unitTexts = segmentUnitTexts(
      pendingHeadings.map((pendingHeading) => serializeSafeNode(pendingHeading.element)).join(""),
    ).map(({ text }) => text);
    const blocks = pendingHeadings.map((pendingHeading) => pendingHeading.block);

    for (const unitText of unitTexts) {
      addSynchronizationUnit(unitText, {
        type: "trailing-headings",
        blocks,
        isSplit: unitTexts.length > 1,
      });
    }
  }

  return {
    sourceTitle: normalizedSourceTitle,
    ...(normalizedSourceSubtitle === undefined ? {} : { sourceSubtitle: normalizedSourceSubtitle }),
    unitRanges,
  };
}

function createSynchronizationUnitId(sequence: number): string {
  return `narration-unit-${String(sequence + 1).padStart(4, "0")}`;
}

/**
 * Replaces each flattened element that holds block content with its children, so that block content
 * ends the surrounding inline run. A flattened element without block content stays whole, so an
 * inline run keeps it as one source node.
 */
function expandFlattenedBlockContent(nodes: readonly SafeNode[]): SafeNode[] {
  return nodes.flatMap((node) =>
    node.type === "flattened" && hasBlockContent(node.children)
      ? expandFlattenedBlockContent(node.children)
      : [node],
  );
}

function hasBlockContent(nodes: readonly SafeNode[]): boolean {
  return nodes.some((node) => {
    if (node.type === "text") {
      return false;
    }

    if (node.type === "flattened") {
      return hasBlockContent(node.children);
    }

    return node.type === "boundary" || !INLINE_TAG_NAMES.has(node.tagName);
  });
}

function getSourceNode(node: SafeNode): SourceChildNode {
  if (node.type === "boundary" || node.source === undefined) {
    throw new CupError("Expected an inline run to hold only nodes of the source material");
  }

  return node.source;
}

function getSourceElement(element: SafeElement): SourceElement {
  if (element.source === undefined) {
    throw new CupError("Expected a narration block to be an element of the source material");
  }

  return element.source;
}

function sanitizeChildren(parentNode: DefaultTreeAdapterMap["parentNode"]): SafeNode[] {
  const safeNodes: SafeNode[] = [];

  for (const childNode of parentNode.childNodes) {
    if ("value" in childNode) {
      safeNodes.push({
        type: "text",
        value: childNode.value.replace(/[\t\n\f\r ]+/gu, " "),
        source: childNode,
      });
      continue;
    }

    if (!("tagName" in childNode) || EXCLUDED_TAG_NAMES.has(childNode.tagName)) {
      continue;
    }

    const safeChildren = sanitizeChildren(childNode);

    if (
      HEADING_TAG_NAMES.has(childNode.tagName) ||
      STRUCTURAL_TAG_NAMES.has(childNode.tagName) ||
      INLINE_TAG_NAMES.has(childNode.tagName)
    ) {
      safeNodes.push({
        type: "element",
        tagName: childNode.tagName,
        children: safeChildren,
        source: childNode,
      });
    } else if (FLATTENED_INLINE_TAG_NAMES.has(childNode.tagName)) {
      safeNodes.push({ type: "flattened", children: safeChildren, source: childNode });
    } else {
      safeNodes.push({ type: "boundary", children: safeChildren });
    }
  }

  return safeNodes;
}

function extractSafeText(nodes: readonly SafeNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") {
        return node.value;
      }

      return node.type === "element" && node.tagName === "br"
        ? "\n"
        : extractSafeText(node.children);
    })
    .join("");
}

function normalizeNarrationText(text: string): string {
  return text
    .replace(/ /gu, " ")
    .replace(/[\t\f\r ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n+/gu, "\n")
    .trim();
}

function normalizeComparableNarrationText(text: string): string {
  return normalizeNarrationText(text).replace(/\s+/gu, " ");
}

function normalizeSafeElement(element: SafeElement): SafeElement {
  return { ...element, children: normalizeSafeNodes(element.children) };
}

// Mirrors the whitespace that the narration document shows, which unit texts are read from.
function normalizeSafeNodes(nodes: readonly SafeNode[]): SafeNode[] {
  const normalizedNodes: SafeNode[] = [];
  let hasVisibleText = false;
  let ignoreWhitespaceUntilVisibleText = true;
  let pendingSeparator: "line-break" | "space" | undefined;

  function normalizeTextNode(node: SafeText, output: SafeNode[]): void {
    for (const character of node.value.replace(/ /gu, " ")) {
      if (character === "\n") {
        if (!ignoreWhitespaceUntilVisibleText) {
          pendingSeparator = "line-break";
        }

        continue;
      }

      if (/[\t\f\r ]/u.test(character)) {
        if (!ignoreWhitespaceUntilVisibleText) {
          pendingSeparator ??= "space";
        }

        continue;
      }

      if (hasVisibleText && pendingSeparator === "line-break") {
        output.push(LINE_BREAK);
      } else if (hasVisibleText && pendingSeparator === "space") {
        appendSafeText(output, " ");
      }

      appendSafeText(output, character);
      hasVisibleText = true;
      ignoreWhitespaceUntilVisibleText = false;
      pendingSeparator = undefined;
    }
  }

  function normalizeElementNode(node: SafeElement, output: SafeNode[]): void {
    if (node.tagName === "br") {
      if (!ignoreWhitespaceUntilVisibleText) {
        pendingSeparator = "line-break";
      }

      return;
    }

    const normalizedChildren: SafeNode[] = [];
    const elementText = extractSafeText(node.children);
    const hasElementText = normalizeNarrationText(elementText).length > 0;

    if (hasElementText) {
      const leadingWhitespace = elementText.match(/^[ \t\f\r \n]+/u)?.[0];
      const leadingSeparator = leadingWhitespace?.includes("\n") ? "line-break" : "space";

      if (hasVisibleText && (pendingSeparator || leadingWhitespace)) {
        if (pendingSeparator === "line-break" || leadingSeparator === "line-break") {
          output.push(LINE_BREAK);
        } else {
          appendSafeText(output, " ");
        }
      }

      pendingSeparator = undefined;
      ignoreWhitespaceUntilVisibleText = Boolean(leadingWhitespace);
    }

    for (const childNode of node.children) {
      normalizeNode(childNode, normalizedChildren);
    }

    output.push({ ...node, children: normalizedChildren });
  }

  function normalizeNode(node: SafeNode, output: SafeNode[]): void {
    if (node.type === "boundary" || node.type === "flattened") {
      for (const childNode of node.children) {
        normalizeNode(childNode, output);
      }

      return;
    }

    if (node.type === "element") {
      normalizeElementNode(node, output);
      return;
    }

    normalizeTextNode(node, output);
  }

  for (const node of nodes) {
    normalizeNode(node, normalizedNodes);
  }

  return normalizedNodes;
}

function appendSafeText(output: SafeNode[], value: string): void {
  const lastNode = output[output.length - 1];

  if (lastNode?.type === "text") {
    lastNode.value += value;
  } else {
    output.push({ type: "text", value });
  }
}

// Unit texts are read from tag names and text alone, so the markup carries no attributes.
function serializeSafeNode(node: SafeNode): string {
  if (node.type === "text") {
    return escapeHtmlText(node.value);
  }

  if (node.type !== "element") {
    return node.children.map(serializeSafeNode).join("");
  }

  if (node.tagName === "br") {
    return "<br>";
  }

  return `<${node.tagName}>${node.children.map(serializeSafeNode).join("")}</${node.tagName}>`;
}

function escapeHtmlText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}
