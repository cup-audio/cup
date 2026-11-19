import type { DefaultTreeAdapterMap } from "parse5";

import { CupError } from "@cup/errors";

import type { NarrationBlock, SegmentedDocument, UnitRange } from "#src/segmentation.ts";

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

// Paragraphs are narration blocks, so only the other structural elements wrap units.
const WRAPPER_TAG_NAMES = new Set(["blockquote", "li", "ol", "ul"]);

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

// The separator that segmentation's text ranges count between the blocks of one unit.
const NARRATION_ELEMENT_SEPARATOR = "\n\n";

type SourceChildNode = DefaultTreeAdapterMap["childNode"];

type SafeText = { type: "text"; value: string };
type SafeBoundary = { type: "boundary"; children: readonly SafeNode[] };
type SafeElement = {
  type: "element";
  tagName: string;
  attributes: readonly SafeAttribute[];
  children: readonly SafeNode[];
  // Identifies a wrapper, so that consecutive units inside one source element share it.
  source?: object;
};
type SafeNode = SafeBoundary | SafeElement | SafeText;
type SafeAttribute = { name: string; value: string };
type RenderedUnit = { html: string; wrappers: readonly SafeElement[] };

// Groups the source title and source subtitle units; its source differs from every element of the
// source material, so serializeRenderedUnits never merges it with a body wrapper.
const SOURCE_HEADING_GROUP: SafeElement = {
  type: "element",
  tagName: "hgroup",
  attributes: [],
  children: [],
  source: {},
};

/** Turns a segmented document into the narration document's safe display HTML. */
export function presentNarrationDocument(segmentedDocument: SegmentedDocument): string {
  const renderedUnits = segmentedDocument.unitRanges.map((unitRange) =>
    renderUnit(segmentedDocument, unitRange),
  );

  return `<article>${serializeRenderedUnits(renderedUnits)}</article>`;
}

function renderUnit(segmentedDocument: SegmentedDocument, unitRange: UnitRange): RenderedUnit {
  const { id, narrationText } = unitRange.synchronizationUnit;
  const unitIdAttributes = [{ name: "id", value: id }];
  const openingWrappers =
    segmentedDocument.sourceSubtitle === undefined ? [] : [SOURCE_HEADING_GROUP];

  if (unitRange.type === "source-title") {
    return {
      html: serializeNarrationTextElement("h1", unitIdAttributes, narrationText),
      wrappers: openingWrappers,
    };
  }

  if (unitRange.type === "source-subtitle") {
    return {
      html: serializeNarrationTextElement("p", unitIdAttributes, narrationText),
      wrappers: openingWrappers,
    };
  }

  // Headings that no block followed are shown outside any container they sat in.
  if (unitRange.type === "trailing-headings") {
    return {
      html: unitRange.isSplit
        ? serializeNarrationTextElement("p", unitIdAttributes, narrationText)
        : serializeUnitElements(unitRange.blocks.map(createNarrationElement), unitIdAttributes),
      wrappers: [],
    };
  }

  const narrationElements = unitRange.blocks.map(createNarrationElement);
  const wrappers = findWrappers(unitRange.blocks[unitRange.blocks.length - 1]!);

  if (unitRange.textRange === undefined) {
    return {
      html: serializeUnitElements(narrationElements, unitIdAttributes),
      wrappers,
    };
  }

  const elementSlices = sliceNarrationElements({
    narrationElements,
    narrationElementTexts: narrationElements.map((narrationElement) =>
      normalizeNarrationText(extractSafeText(narrationElement.children)),
    ),
    textRange: unitRange.textRange,
  });

  return {
    html: serializeUnitElements(elementSlices, unitIdAttributes),
    wrappers,
  };
}

function createNarrationElement(block: NarrationBlock): SafeElement {
  if (block.type === "inline-run") {
    return normalizeSafeElement({
      type: "element",
      tagName: "p",
      attributes: [],
      children: block.nodes.flatMap(sanitizeNode),
    });
  }

  const [element] = sanitizeNode(block.element);

  if (element?.type !== "element") {
    throw new CupError("Expected a narration block element to be kept in the narration document");
  }

  return normalizeSafeElement(element);
}

/** Finds the containers around a block, outermost first. */
function findWrappers(block: NarrationBlock): SafeElement[] {
  const wrappers: SafeElement[] = [];
  let parentNode = (block.type === "element" ? block.element : block.nodes[0]!).parentNode;

  while (parentNode !== null && "tagName" in parentNode) {
    if (WRAPPER_TAG_NAMES.has(parentNode.tagName)) {
      wrappers.unshift({
        type: "element",
        tagName: parentNode.tagName,
        attributes: sanitizeAttributes(parentNode),
        children: [],
        source: parentNode,
      });
    }

    parentNode = parentNode.parentNode;
  }

  return wrappers;
}

function serializeUnitElements(
  elements: readonly SafeElement[],
  unitIdAttributes: readonly SafeAttribute[],
): string {
  return elements.length === 1
    ? serializeSafeElement(elements[0]!, unitIdAttributes)
    : `<section${serializeSafeAttributes(unitIdAttributes)}>${elements.map((element) => serializeSafeElement(element)).join("")}</section>`;
}

function sliceNarrationElements({
  narrationElements,
  narrationElementTexts,
  textRange,
}: {
  narrationElements: readonly SafeElement[];
  narrationElementTexts: readonly string[];
  textRange: { start: number; end: number };
}): SafeElement[] {
  const elementSlices: SafeElement[] = [];
  let elementStart = 0;

  for (const [elementIndex, element] of narrationElements.entries()) {
    const elementText = narrationElementTexts[elementIndex]!;
    const elementEnd = elementStart + elementText.length;
    const overlapStart = Math.max(textRange.start, elementStart);
    const overlapEnd = Math.min(textRange.end, elementEnd);

    if (overlapStart < overlapEnd) {
      elementSlices.push({
        ...element,
        children: sliceSafeNodes(
          element.children,
          overlapStart - elementStart,
          overlapEnd - elementStart,
        ),
      });
    }

    elementStart = elementEnd + NARRATION_ELEMENT_SEPARATOR.length;
  }

  return elementSlices;
}

function sliceSafeNodes(
  nodes: readonly SafeNode[],
  rangeStart: number,
  rangeEnd: number,
): SafeNode[] {
  const slicedNodes: SafeNode[] = [];
  let nodeStart = 0;

  for (const node of nodes) {
    const nodeText = extractSafeText([node]);
    const nodeEnd = nodeStart + nodeText.length;
    const overlapStart = Math.max(rangeStart, nodeStart);
    const overlapEnd = Math.min(rangeEnd, nodeEnd);

    if (overlapStart < overlapEnd) {
      const localStart = overlapStart - nodeStart;
      const localEnd = overlapEnd - nodeStart;

      if (node.type === "text") {
        slicedNodes.push({ type: "text", value: node.value.slice(localStart, localEnd) });
      } else if (node.type === "element" && node.tagName === "br") {
        slicedNodes.push(node);
      } else {
        slicedNodes.push({
          ...node,
          children: sliceSafeNodes(node.children, localStart, localEnd),
        });
      }
    }

    nodeStart = nodeEnd;
  }

  return slicedNodes;
}

function sanitizeNode(node: SourceChildNode): SafeNode[] {
  if ("value" in node) {
    return [{ type: "text", value: node.value.replace(/[\t\n\f\r ]+/gu, " ") }];
  }

  if (!("tagName" in node) || EXCLUDED_TAG_NAMES.has(node.tagName)) {
    return [];
  }

  const safeChildren = node.childNodes.flatMap(sanitizeNode);

  if (
    HEADING_TAG_NAMES.has(node.tagName) ||
    STRUCTURAL_TAG_NAMES.has(node.tagName) ||
    INLINE_TAG_NAMES.has(node.tagName)
  ) {
    return [
      {
        type: "element",
        tagName: node.tagName,
        attributes: sanitizeAttributes(node),
        children: safeChildren,
      },
    ];
  }

  return FLATTENED_INLINE_TAG_NAMES.has(node.tagName)
    ? safeChildren
    : [{ type: "boundary", children: safeChildren }];
}

function sanitizeAttributes(element: DefaultTreeAdapterMap["element"]): SafeAttribute[] {
  const safeAttributes: SafeAttribute[] = [];

  for (const attribute of element.attrs) {
    if (attribute.name === "dir" && ["auto", "ltr", "rtl"].includes(attribute.value)) {
      safeAttributes.push({ name: attribute.name, value: attribute.value });
      continue;
    }

    if (attribute.name === "lang" && attribute.value.trim().length > 0) {
      safeAttributes.push({ name: attribute.name, value: attribute.value });
      continue;
    }

    if (element.tagName === "a" && attribute.name === "href" && isSafeLink(attribute.value)) {
      safeAttributes.push({ name: attribute.name, value: attribute.value });
    }
  }

  return safeAttributes;
}

function isSafeLink(href: string): boolean {
  if (href.trim().length === 0) {
    return false;
  }

  try {
    const url = new URL(href, "https://narration-document.invalid");

    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
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

function normalizeSafeElement(element: SafeElement): SafeElement {
  return { ...element, children: normalizeSafeNodes(element.children) };
}

// Keep browser-visible whitespace aligned with the units' narration text normalization.
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
        output.push({ type: "element", tagName: "br", attributes: [], children: [] });
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
          output.push({ type: "element", tagName: "br", attributes: [], children: [] });
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
    if (node.type === "boundary") {
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

function serializeSafeNode(node: SafeNode): string {
  if (node.type === "text") {
    return escapeHtmlText(node.value);
  }

  return node.type === "boundary"
    ? node.children.map(serializeSafeNode).join("")
    : serializeSafeElement(node);
}

function serializeSafeElement(
  element: SafeElement,
  generatedAttributes: readonly SafeAttribute[] = [],
): string {
  const attributes = serializeSafeAttributes([...generatedAttributes, ...element.attributes]);

  if (element.tagName === "br") {
    return `<br${attributes}>`;
  }

  return `<${element.tagName}${attributes}>${element.children.map(serializeSafeNode).join("")}</${element.tagName}>`;
}

function serializeRenderedUnits(renderedUnits: readonly RenderedUnit[]): string {
  let html = "";
  let unitIndex = 0;

  while (unitIndex < renderedUnits.length) {
    const renderedUnit = renderedUnits[unitIndex]!;
    const firstWrapper = renderedUnit.wrappers[0];

    if (!firstWrapper) {
      html += renderedUnit.html;
      unitIndex += 1;
      continue;
    }

    const wrappedUnits: RenderedUnit[] = [];

    while (unitIndex < renderedUnits.length) {
      const candidateUnit = renderedUnits[unitIndex]!;
      const candidateWrapper = candidateUnit.wrappers[0];

      if (!candidateWrapper || candidateWrapper.source !== firstWrapper.source) {
        break;
      }

      wrappedUnits.push({
        html: candidateUnit.html,
        wrappers: candidateUnit.wrappers.slice(1),
      });
      unitIndex += 1;
    }

    html += `<${firstWrapper.tagName}${serializeSafeAttributes(firstWrapper.attributes)}>${serializeRenderedUnits(wrappedUnits)}</${firstWrapper.tagName}>`;
  }

  return html;
}

function serializeSafeAttributes(attributes: readonly SafeAttribute[]): string {
  return attributes.map(({ name, value }) => ` ${name}="${escapeHtmlAttribute(value)}"`).join("");
}

function serializeNarrationTextElement(
  tagName: string,
  attributes: readonly SafeAttribute[],
  text: string,
): string {
  const html = text.split("\n").map(escapeHtmlText).join("<br>");

  return `<${tagName}${serializeSafeAttributes(attributes)}>${html}</${tagName}>`;
}

function escapeHtmlText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtmlText(text).replace(/"/gu, "&quot;");
}
