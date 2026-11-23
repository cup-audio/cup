import type { DefaultTreeAdapterMap } from "parse5";

import { CupError } from "@cup/errors";

import { escapeHtmlAttribute, escapeHtmlText } from "#src/html-escaping.ts";
import { resolveLink } from "#src/links.ts";
import {
  FLATTENED_INLINE_TAG_NAMES,
  KEPT_INLINE_TAG_NAMES,
  serializeUnitAttribute,
  wrapInScrollCard,
} from "#src/presentation-rules.ts";
import type { NarrationBlock, SegmentedDocument, UnitRange } from "#src/segmentation.ts";

const DROPPED_TAG_NAMES = new Set([
  "audio",
  "canvas",
  "embed",
  "hr",
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

const CONTAINER_TAG_NAMES = new Set(["blockquote", "dd", "dl", "dt", "li", "ol", "pre", "ul"]);

const TABLE_PART_TAG_NAMES = new Set(["caption", "tbody", "td", "tfoot", "th", "thead", "tr"]);

const UNIT_CELL_TAG_NAMES = new Set(["caption", "dd", "dt", "pre", "td", "th"]);

const TABLE_CELL_TAG_NAMES = new Set(["td", "th"]);
const ITEM_TAG_NAMES = new Set(["dd", "dt", "td", "th"]);

const NARRATION_ELEMENT_SEPARATOR = "\n\n";

type SourceNode = DefaultTreeAdapterMap["childNode"];
type SourceElement = DefaultTreeAdapterMap["element"];

type SafeText = { type: "text"; value: string };
type SafeElement = {
  type: "element";
  tagName: string;
  attributes: readonly SafeAttribute[];
  children: readonly SafeNode[];
};
type SafeIndentation = { type: "indentation"; value: string };
type SafeNode = SafeElement | SafeIndentation | SafeText;
type SafeAttribute = { name: string; value: string };

type BlockPart = { unitId: string; textRange?: { start: number; end: number } };

type PresentedBlock = { block: NarrationBlock; element: SafeElement; parts: BlockPart[] };

type PresentedFragment = { html: string; hasUnits: boolean };

const EMPTY_FRAGMENT: PresentedFragment = { html: "", hasUnits: false };

export function presentNarrationDocument({
  segmentedDocument,
  baseUrl,
}: {
  segmentedDocument: SegmentedDocument;
  baseUrl: string;
}): string {
  const presentedBlocks = presentBlocks(segmentedDocument.unitRanges, baseUrl);
  const isInsideTable = new WeakSet<SourceElement>();

  function presentNodes(nodes: readonly SourceNode[]): PresentedFragment {
    const fragments = nodes.map(presentNode);

    return {
      html: fragments.map((fragment) => fragment.html).join(""),
      hasUnits: fragments.some((fragment) => fragment.hasUnits),
    };
  }

  function presentNode(node: SourceNode): PresentedFragment {
    const presentedBlock = presentedBlocks.get(node);

    if (presentedBlock !== undefined) {
      return { html: serializeBlockParts(presentedBlock, presentedBlock.element), hasUnits: true };
    }

    if (!("tagName" in node) || DROPPED_TAG_NAMES.has(node.tagName)) {
      return EMPTY_FRAGMENT;
    }

    const { tagName } = node;
    const isTablePart = TABLE_PART_TAG_NAMES.has(tagName) && isInsideTable.has(node);

    if (tagName === "table" || isTablePart) {
      for (const childNode of node.childNodes) {
        if ("tagName" in childNode) {
          isInsideTable.add(childNode);
        }
      }
    }

    if (UNIT_CELL_TAG_NAMES.has(tagName) && (!TABLE_PART_TAG_NAMES.has(tagName) || isTablePart)) {
      const unitCell = presentUnitCell(node);

      if (unitCell !== undefined) {
        return unitCell;
      }
    }

    const content = presentNodes(node.childNodes);

    if (tagName === "table") {
      return content.hasUnits
        ? { html: wrapInScrollCard(`<table>${content.html}</table>`), hasUnits: true }
        : EMPTY_FRAGMENT;
    }

    if (isTablePart) {
      return { html: `<${tagName}>${content.html}</${tagName}>`, hasUnits: content.hasUnits };
    }

    if (CONTAINER_TAG_NAMES.has(tagName) && content.hasUnits) {
      const html = `<${tagName}>${content.html}</${tagName}>`;

      return { html: tagName === "pre" ? wrapInScrollCard(html) : html, hasUnits: true };
    }

    return CONTAINER_TAG_NAMES.has(tagName) ? EMPTY_FRAGMENT : content;
  }

  function presentUnitCell(cell: SourceElement): PresentedFragment | undefined {
    const presentedBlock = cell.childNodes
      .map((childNode) => presentedBlocks.get(childNode))
      .find((candidate) => candidate !== undefined);

    if (presentedBlock?.block.type !== "inline-run") {
      return undefined;
    }

    const runNodes = presentedBlock.block.nodes;
    const isWholeCell = cell.childNodes.every(
      (childNode) => runNodes.includes(childNode) || extractSourceText(childNode).trim() === "",
    );
    const isOneUnit = presentedBlock.parts.length === 1 && !presentedBlock.parts[0]!.textRange;

    if (!isWholeCell || (cell.tagName !== "pre" && !isOneUnit)) {
      return undefined;
    }

    const html = serializeBlockParts(presentedBlock, {
      ...presentedBlock.element,
      tagName: cell.tagName,
    });

    return { html: cell.tagName === "pre" ? wrapInScrollCard(html) : html, hasUnits: true };
  }

  const body = presentNodes(segmentedDocument.sourceMaterial.childNodes);

  return `<article>${presentSourceHeadings(segmentedDocument)}${body.html}</article>`;
}

function presentSourceHeadings({ sourceSubtitle, unitRanges }: SegmentedDocument): string {
  const [sourceTitleUnit, sourceSubtitleUnit] = unitRanges.map(
    (unitRange) => unitRange.synchronizationUnit,
  );
  const sourceTitleHtml = serializeNarrationTextElement("h1", sourceTitleUnit!);

  return sourceSubtitle === undefined
    ? sourceTitleHtml
    : `<hgroup>${sourceTitleHtml}${serializeNarrationTextElement("p", sourceSubtitleUnit!)}</hgroup>`;
}

function presentBlocks(
  unitRanges: readonly UnitRange[],
  baseUrl: string,
): Map<SourceNode, PresentedBlock> {
  const presentedBlocks = new Map<SourceNode, PresentedBlock>();
  const trailingHeadingsSearchStarts = new Map<readonly NarrationBlock[], number>();

  function getPresentedBlock(block: NarrationBlock): PresentedBlock {
    const blockKey = block.type === "element" ? block.element : block.nodes[0]!;
    let presentedBlock = presentedBlocks.get(blockKey);

    if (presentedBlock === undefined) {
      presentedBlock = { block, element: createNarrationElement(block, baseUrl), parts: [] };
      presentedBlocks.set(blockKey, presentedBlock);
    }

    return presentedBlock;
  }

  for (const unitRange of unitRanges) {
    if (unitRange.type === "source-title" || unitRange.type === "source-subtitle") {
      continue;
    }

    const unitId = unitRange.synchronizationUnit.id;
    const unitBlocks = unitRange.blocks.map(getPresentedBlock);
    const blockTexts = unitBlocks.map(({ element }) =>
      normalizeNarrationText(extractSafeText(element.children)),
    );
    let textRange = unitRange.type === "body" ? unitRange.textRange : undefined;

    if (unitRange.type === "trailing-headings" && unitRange.isSplit) {
      const searchStart = trailingHeadingsSearchStarts.get(unitRange.blocks) ?? 0;
      const { narrationText } = unitRange.synchronizationUnit;
      const start = blockTexts
        .join(NARRATION_ELEMENT_SEPARATOR)
        .indexOf(narrationText, searchStart);

      if (start < 0) {
        throw new CupError("Expected every unit text to occur in its trailing headings");
      }

      textRange = { start, end: start + narrationText.length };
      trailingHeadingsSearchStarts.set(unitRange.blocks, textRange.end);
    }

    let blockStart = 0;

    for (const [blockIndex, presentedBlock] of unitBlocks.entries()) {
      const blockEnd = blockStart + blockTexts[blockIndex]!.length;

      if (textRange === undefined) {
        presentedBlock.parts.push({ unitId });
      } else if (Math.max(textRange.start, blockStart) < Math.min(textRange.end, blockEnd)) {
        presentedBlock.parts.push({
          unitId,
          textRange: {
            start: Math.max(textRange.start, blockStart) - blockStart,
            end: Math.min(textRange.end, blockEnd) - blockStart,
          },
        });
      }

      blockStart = blockEnd + NARRATION_ELEMENT_SEPARATOR.length;
    }
  }

  return presentedBlocks;
}

function createNarrationElement(block: NarrationBlock, baseUrl: string): SafeElement {
  if (block.type === "element" && block.element.tagName === "tr") {
    return {
      type: "element",
      tagName: "tr",
      attributes: [],
      children: block.element.childNodes
        .filter(
          (childNode): childNode is SourceElement =>
            "tagName" in childNode && TABLE_CELL_TAG_NAMES.has(childNode.tagName),
        )
        .map((cell) => createItemElement(cell, baseUrl)),
    };
  }

  if (block.type === "element" && ITEM_TAG_NAMES.has(block.element.tagName)) {
    return createItemElement(block.element, baseUrl);
  }

  const firstNode = block.type === "element" ? block.element : block.nodes[0]!;
  const context = {
    baseUrl,
    isPreformatted: hasPreformattedAncestor(firstNode),
    separatesBlocks: false,
  };
  const element: SafeElement =
    block.type === "element"
      ? {
          type: "element",
          tagName: block.element.tagName,
          attributes: [],
          children: block.element.childNodes.flatMap((node) => sanitizeNode(node, context)),
        }
      : {
          type: "element",
          tagName: "p",
          attributes: [],
          children: block.nodes.flatMap((node) => sanitizeNode(node, context)),
        };

  return { ...element, children: normalizeSafeNodes(element.children) };
}

function createItemElement(item: SourceElement, baseUrl: string): SafeElement {
  const context = {
    baseUrl,
    isPreformatted: hasPreformattedAncestor(item),
    separatesBlocks: true,
  };

  return {
    type: "element",
    tagName: item.tagName,
    attributes: [],
    children: normalizeSafeNodes(item.childNodes.flatMap((node) => sanitizeNode(node, context))),
  };
}

function hasPreformattedAncestor(node: SourceNode): boolean {
  let parentNode = node.parentNode;

  while (parentNode !== null && "tagName" in parentNode) {
    if (parentNode.tagName === "pre") {
      return true;
    }

    parentNode = parentNode.parentNode;
  }

  return false;
}

function sanitizeNode(
  node: SourceNode,
  context: { baseUrl: string; isPreformatted: boolean; separatesBlocks: boolean },
): SafeNode[] {
  if ("value" in node) {
    if (!context.isPreformatted) {
      return [{ type: "text", value: node.value.replace(/[\t\n\f\r ]+/gu, " ") }];
    }

    return node.value
      .split(/(?<=^|\n)([\t ]+)/u)
      .map((value, index) =>
        index % 2 === 1
          ? { type: "indentation", value }
          : { type: "text", value: value.replace(/[\t\f\r ]+/gu, " ") },
      );
  }

  if (!("tagName" in node) || DROPPED_TAG_NAMES.has(node.tagName)) {
    return [];
  }

  const childContext =
    context.separatesBlocks && node.tagName === "pre"
      ? { ...context, isPreformatted: true }
      : context;
  const children = node.childNodes.flatMap((childNode) => sanitizeNode(childNode, childContext));

  if (node.tagName === "a") {
    const href = resolveLink({
      href: node.attrs.find((attribute) => attribute.name === "href")?.value,
      baseUrl: context.baseUrl,
    });
    const hasText = normalizeNarrationText(extractSafeText(children)).length > 0;

    return href === undefined || !hasText
      ? children
      : [{ type: "element", tagName: "a", attributes: [{ name: "href", value: href }], children }];
  }

  if (KEPT_INLINE_TAG_NAMES.has(node.tagName)) {
    return [{ type: "element", tagName: node.tagName, attributes: [], children }];
  }

  return context.separatesBlocks && !FLATTENED_INLINE_TAG_NAMES.has(node.tagName)
    ? [{ type: "text", value: " " }, ...children, { type: "text", value: " " }]
    : children;
}

function extractSourceText(node: SourceNode): string {
  if ("value" in node) {
    return node.value;
  }

  return "tagName" in node && !DROPPED_TAG_NAMES.has(node.tagName)
    ? node.childNodes.map(extractSourceText).join("")
    : "";
}

function extractSafeText(
  nodes: readonly SafeNode[],
  { withIndentation = false }: { withIndentation?: boolean } = {},
): string {
  return nodes
    .map((node) => {
      if (node.type === "text") {
        return node.value;
      }

      if (node.type === "indentation") {
        return withIndentation ? node.value : "";
      }

      return node.tagName === "br" ? "\n" : extractSafeText(node.children, { withIndentation });
    })
    .join("");
}

function normalizeNarrationText(text: string): string {
  return text
    .replace(/\u00A0/gu, " ")
    .replace(/[\t\f\r ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n+/gu, "\n")
    .trim();
}

function normalizeSafeNodes(nodes: readonly SafeNode[]): SafeNode[] {
  const normalizedNodes: SafeNode[] = [];
  let hasVisibleText = false;
  let ignoreWhitespaceUntilVisibleText = true;
  let pendingSeparator: "line-break" | "space" | undefined;
  let pendingIndentation: SafeIndentation | undefined;

  function pushLineBreak(output: SafeNode[]): void {
    output.push({ type: "element", tagName: "br", attributes: [], children: [] });
    pushPendingIndentation(output);
  }

  function pushPendingIndentation(output: SafeNode[]): void {
    if (pendingIndentation !== undefined) {
      output.push(pendingIndentation);
      pendingIndentation = undefined;
    }
  }

  function normalizeIndentationNode(node: SafeIndentation): void {
    if (!hasVisibleText || pendingSeparator === "line-break") {
      pendingIndentation = node;
    } else if (!ignoreWhitespaceUntilVisibleText) {
      pendingSeparator ??= "space";
    }
  }

  function normalizeTextNode(node: SafeText, output: SafeNode[]): void {
    for (const character of node.value.replace(/\u00A0/gu, " ")) {
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
        pushLineBreak(output);
      } else if (hasVisibleText && pendingSeparator === "space") {
        appendSafeText(output, " ");
      } else if (!hasVisibleText) {
        pushPendingIndentation(output);
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
      const leadingWhitespace = extractSafeText(node.children, { withIndentation: true }).match(
        /^[\u00A0\t\f\r \n]+/u,
      )?.[0];
      const leadingSeparator = leadingWhitespace?.includes("\n") ? "line-break" : "space";

      if (hasVisibleText && (pendingSeparator || leadingWhitespace)) {
        if (pendingSeparator === "line-break" || leadingSeparator === "line-break") {
          pushLineBreak(output);
        } else {
          appendSafeText(output, " ");
        }
      } else if (!hasVisibleText) {
        pushPendingIndentation(output);
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
    if (node.type === "element") {
      normalizeElementNode(node, output);
      return;
    }

    if (node.type === "indentation") {
      normalizeIndentationNode(node);
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

function serializeBlockParts(presentedBlock: PresentedBlock, element: SafeElement): string {
  return presentedBlock.parts
    .map(({ unitId, textRange }) =>
      serializeSafeElement(
        textRange === undefined
          ? element
          : { ...element, children: sliceSafeNodes(element.children, textRange) },
        unitId,
      ),
    )
    .join("");
}

function sliceSafeNodes(
  nodes: readonly SafeNode[],
  range: { start: number; end: number },
): SafeNode[] {
  const slicedNodes: SafeNode[] = [];
  let nodeStart = 0;

  for (const node of nodes) {
    const nodeEnd = nodeStart + extractSafeText([node]).length;
    const overlapStart = Math.max(range.start, nodeStart);
    const overlapEnd = Math.min(range.end, nodeEnd);

    if (node.type === "indentation") {
      if (range.start <= nodeStart && nodeStart < range.end) {
        slicedNodes.push(node);
      }
    } else if (overlapStart < overlapEnd) {
      const localRange = { start: overlapStart - nodeStart, end: overlapEnd - nodeStart };

      if (node.type === "text") {
        slicedNodes.push({
          type: "text",
          value: node.value.slice(localRange.start, localRange.end),
        });
      } else if (node.tagName === "br") {
        slicedNodes.push(node);
      } else {
        slicedNodes.push({ ...node, children: sliceSafeNodes(node.children, localRange) });
      }
    }

    nodeStart = nodeEnd;
  }

  return slicedNodes;
}

function serializeSafeNode(node: SafeNode): string {
  return node.type === "element" ? serializeSafeElement(node) : escapeHtmlText(node.value);
}

function serializeSafeElement(element: SafeElement, unitId?: string): string {
  const unitAttribute = unitId === undefined ? "" : serializeUnitAttribute(unitId);
  const attributes = element.attributes
    .map(({ name, value }) => ` ${name}="${escapeHtmlAttribute(value)}"`)
    .join("");

  if (element.tagName === "br") {
    return `<br${unitAttribute}${attributes}>`;
  }

  return `<${element.tagName}${unitAttribute}${attributes}>${element.children.map(serializeSafeNode).join("")}</${element.tagName}>`;
}

function serializeNarrationTextElement(
  tagName: string,
  { id, narrationText }: { id: string; narrationText: string },
): string {
  const html = narrationText.split("\n").map(escapeHtmlText).join("<br>");

  return `<${tagName}${serializeUnitAttribute(id)}>${html}</${tagName}>`;
}
