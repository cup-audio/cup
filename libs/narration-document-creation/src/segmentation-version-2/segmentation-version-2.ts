import type { DefaultTreeAdapterMap } from "parse5";

import { CupError } from "@cup/errors";

import {
  MAX_UNIT_TEXT_CHARACTERS,
  segmentUnitTexts,
  splitNarrationBlock,
} from "#src/segmentation-version-1/unit-text-segmentation.ts";
import type { NarrationBlock, UnitRange } from "#src/segmentation.ts";

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

const TABLE_CELL_TAG_NAMES = new Set(["td", "th"]);

const NARRATION_ELEMENT_SEPARATOR = "\n\n";

const TABLE_CELL_SEPARATOR = ", ";

type SourceElement = DefaultTreeAdapterMap["element"];
type SourceChildNode = DefaultTreeAdapterMap["childNode"];

type SafeText = { type: "text"; value: string; source?: SourceChildNode };
type SafeBoundary = {
  type: "boundary";
  tagName: string;
  children: readonly SafeNode[];
  source: SourceElement;
};
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

export function segmentWithVersion2({
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

  const safeNodes = sanitizeChildren(sourceMaterial, { isPreformatted: false });
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

    addSplitBodyUnits(combinedNarrationText, unitTexts, blocks);
  }

  function addSplitBodyUnits(
    combinedNarrationText: string,
    unitTexts: readonly string[],
    blocks: readonly NarrationBlock[],
  ): void {
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

  function addTextBlockUnits(
    textBlocks: readonly { block: NarrationBlock; text: string }[],
    splitText: (text: string) => string[],
  ): void {
    const pendingHeadingBlocks = pendingHeadings.map((pendingHeading) => ({
      block: pendingHeading.block,
      text: normalizeNarrationText(extractSafeText(pendingHeading.element.children)),
    }));
    const unitBlocks = [...pendingHeadingBlocks, ...textBlocks];
    const combinedNarrationText = unitBlocks
      .map(({ text }) => text)
      .join(NARRATION_ELEMENT_SEPARATOR);
    const blocks = unitBlocks.map(({ block }) => block);
    const unitTexts = splitText(combinedNarrationText);

    pendingHeadings.length = 0;

    if (unitTexts.length === 1) {
      addSynchronizationUnit(unitTexts[0]!, { type: "body", blocks });
      return;
    }

    addSplitBodyUnits(combinedNarrationText, unitTexts, blocks);
  }

  function visitNodes(nodes: readonly SafeNode[], isPreformatted: boolean): void {
    let directContent: SafeNode[] = [];

    function flushDirectContent(): void {
      if (normalizeNarrationText(extractSafeText(directContent)).length > 0) {
        addNarrationBlock(
          { type: "element", tagName: "p", children: directContent },
          { type: "inline-run", nodes: directContent.map(getSourceNode) },
          isPreformatted,
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

        if (node.tagName === "tr") {
          addTableRow(node, isPreformatted);
        } else if (node.tagName === "dl") {
          addDescriptionList(node, isPreformatted);
        } else {
          visitNodes(node.children, isPreformatted || node.tagName === "pre");
        }

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
        addNarrationBlock(node, { type: "element", element: getSourceElement(node) }, false);
        continue;
      }

      flushDirectContent();
      visitNodes(node.children, isPreformatted);
    }

    flushDirectContent();
  }

  function addNarrationBlock(
    element: SafeElement,
    block: NarrationBlock,
    isPreformatted: boolean,
  ): void {
    const narrationElements = [
      ...pendingHeadings.map((pendingHeading) => pendingHeading.element),
      normalizeSafeElement(element),
    ];

    if (!isPreformatted) {
      addBodyUnits(narrationElements, [
        ...pendingHeadings.map((pendingHeading) => pendingHeading.block),
        block,
      ]);
      return;
    }

    addTextBlockUnits(
      [
        {
          block,
          text: normalizeNarrationText(extractSafeText(narrationElements.at(-1)!.children)),
        },
      ],
      splitAtLineBreaks,
    );
  }

  function addTableRow(row: SafeBoundary, isPreformatted: boolean): void {
    const cellTexts = row.children
      .filter(
        (node): node is SafeBoundary =>
          node.type === "boundary" && TABLE_CELL_TAG_NAMES.has(node.tagName),
      )
      .map((cell) => extractItemText(cell))
      .filter((cellText) => cellText.length > 0);

    if (cellTexts.length === 0) {
      return;
    }

    const rowText = cellTexts.join(TABLE_CELL_SEPARATOR);
    const unitText = [
      ...pendingHeadings.map((pendingHeading) =>
        normalizeNarrationText(extractSafeText(pendingHeading.element.children)),
      ),
      rowText,
    ].join(NARRATION_ELEMENT_SEPARATOR);

    if (unitText.length > MAX_UNIT_TEXT_CHARACTERS) {
      visitNodes(row.children, isPreformatted);
      return;
    }

    addTextBlockUnits(
      [{ block: { type: "element", element: row.source }, text: rowText }],
      (text) => [text],
    );
  }

  function addDescriptionList(list: SafeBoundary, isPreformatted: boolean): void {
    let group: { block: NarrationBlock; text: string }[] = [];
    let hasDescription = false;

    function flushGroup(): void {
      if (group.length > 0) {
        addTextBlockUnits(group, splitNarrationBlock);
      }

      group = [];
      hasDescription = false;
    }

    function visitGroupNodes(nodes: readonly SafeNode[]): void {
      for (const node of nodes) {
        if (node.type === "boundary" && (node.tagName === "dt" || node.tagName === "dd")) {
          if (node.tagName === "dt" && hasDescription) {
            flushGroup();
          }

          hasDescription ||= node.tagName === "dd";

          const text = extractItemText(node);

          if (text.length > 0) {
            group.push({ block: { type: "element", element: node.source }, text });
          }

          continue;
        }

        if (node.type === "text" && normalizeNarrationText(node.value).length === 0) {
          continue;
        }

        flushGroup();

        if (node.type === "boundary" && node.tagName === "div") {
          visitGroupNodes(node.children);
          flushGroup();
          continue;
        }

        visitNodes([node], isPreformatted);
      }
    }

    visitGroupNodes(list.children);
    flushGroup();
  }

  addSynchronizationUnit(normalizedSourceTitle, { type: "source-title" });

  if (normalizedSourceSubtitle !== undefined) {
    addSynchronizationUnit(normalizedSourceSubtitle, { type: "source-subtitle" });
  }

  visitNodes(safeNodes, false);

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

function splitAtLineBreaks(text: string): string[] {
  const unitTexts: string[] = [];
  let currentPart = "";

  for (const line of text.split("\n")) {
    const combinedPart = currentPart.length === 0 ? line : `${currentPart}\n${line}`;

    if (combinedPart.length <= MAX_UNIT_TEXT_CHARACTERS) {
      currentPart = combinedPart;
      continue;
    }

    if (currentPart.length > 0) {
      unitTexts.push(currentPart);
    }

    const lineParts = splitNarrationBlock(line);

    unitTexts.push(...lineParts.slice(0, -1));
    currentPart = lineParts.at(-1)!;
  }

  unitTexts.push(currentPart);

  return unitTexts.map((unitText) => unitText.trim()).filter((unitText) => unitText.length > 0);
}

function extractItemText(item: SafeBoundary): string {
  return normalizeNarrationText(extractFlattenedText(item.children));
}

function extractFlattenedText(nodes: readonly SafeNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") {
        return node.value;
      }

      if (node.type === "flattened") {
        return extractFlattenedText(node.children);
      }

      if (node.type === "element" && INLINE_TAG_NAMES.has(node.tagName)) {
        return node.tagName === "br" ? "\n" : extractFlattenedText(node.children);
      }

      return ` ${extractFlattenedText(node.children)} `;
    })
    .join("");
}

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

function sanitizeChildren(
  parentNode: DefaultTreeAdapterMap["parentNode"],
  context: { isPreformatted: boolean },
): SafeNode[] {
  const safeNodes: SafeNode[] = [];

  for (const childNode of parentNode.childNodes) {
    if ("value" in childNode) {
      safeNodes.push({
        type: "text",
        value: childNode.value.replace(
          context.isPreformatted ? /[\t\f\r ]+/gu : /[\t\n\f\r ]+/gu,
          " ",
        ),
        source: childNode,
      });
      continue;
    }

    if (!("tagName" in childNode) || EXCLUDED_TAG_NAMES.has(childNode.tagName)) {
      continue;
    }

    const safeChildren = sanitizeChildren(childNode, {
      isPreformatted: context.isPreformatted || childNode.tagName === "pre",
    });

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
      safeNodes.push({
        type: "boundary",
        tagName: childNode.tagName,
        children: safeChildren,
        source: childNode,
      });
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
