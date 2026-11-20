import { parseFragment } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";

import { escapeHtmlAttribute, escapeHtmlText } from "#src/html-escaping.ts";
import { resolveLink } from "#src/links.ts";

/** A unit found in an existing conversion's stored HTML, with the text its elements show. */
export type PresentedUnit = { id: string; text: string };

const SYNCHRONIZATION_UNIT_ATTRIBUTE = "data-synchronization-unit";

const BLOCK_TAG_NAMES = new Set([
  "article",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hgroup",
  "li",
  "ol",
  "p",
  "ul",
]);

const HEADING_TAG_NAMES = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

// Containers that narration document creation drew a heading inside, when the heading came right
// before the container in the narration source material.
const HEADING_CONTAINER_TAG_NAMES = new Set(["blockquote", "ol", "ul"]);

const CONTAINER_TAG_NAMES = new Set(["blockquote", "li", "ol", "ul"]);

// Stored HTML only ever held these inline elements; any other element is flattened to its text.
const INLINE_TAG_NAMES = new Set(["code", "em", "strong"]);

type Element = DefaultTreeAdapterMap["element"];
type ChildNode = DefaultTreeAdapterMap["childNode"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

/**
 * Presents the HTML an existing conversion stored in its manifest: every element or `section`
 * carrying a unit ID becomes one or more elements marked with the unit attribute, headings drawn
 * inside a container move before it, and links resolve against the conversion's source URL.
 */
export function presentStoredNarrationDocument({
  storedHtml,
  baseUrl,
}: {
  storedHtml: string;
  baseUrl: string;
}): { html: string; units: PresentedUnit[] } {
  const fragment = parseFragment(storedHtml);
  const units: PresentedUnit[] = [];

  moveHeadingsOutOfContainers(fragment);

  function addUnitText(unitId: string, text: string): void {
    const lastUnit = units[units.length - 1];

    if (lastUnit?.id === unitId) {
      lastUnit.text += text;
    } else {
      units.push({ id: unitId, text });
    }
  }

  function presentNodes(nodes: readonly ChildNode[], unitId: string | undefined): string {
    return nodes.map((node) => presentNode(node, unitId, false)).join("");
  }

  function presentNode(
    node: ChildNode,
    inheritedUnitId: string | undefined,
    isUnitElement: boolean,
  ): string {
    if ("value" in node) {
      if (inheritedUnitId !== undefined) {
        addUnitText(inheritedUnitId, node.value);
      }

      return escapeHtmlText(node.value);
    }

    if (!("tagName" in node)) {
      return "";
    }

    const storedUnitId = node.attrs.find((attribute) => attribute.name === "id")?.value;
    const unitId = storedUnitId ?? inheritedUnitId;

    if (storedUnitId !== undefined) {
      // Registers the unit even when its elements hold no text, so the check sees it.
      addUnitText(storedUnitId, "");
    }

    // A section only grouped the elements of one unit; each of them now carries the unit itself.
    if (node.tagName === "section") {
      return node.childNodes
        .map((childNode) => presentNode(childNode, unitId, unitId !== undefined))
        .join("");
    }

    if (BLOCK_TAG_NAMES.has(node.tagName)) {
      const unitAttribute =
        unitId !== undefined && (storedUnitId !== undefined || isUnitElement)
          ? ` ${SYNCHRONIZATION_UNIT_ATTRIBUTE}="${escapeHtmlAttribute(unitId)}"`
          : "";

      return `<${node.tagName}${unitAttribute}>${presentNodes(node.childNodes, unitId)}</${node.tagName}>`;
    }

    if (node.tagName === "br") {
      return "<br>";
    }

    if (INLINE_TAG_NAMES.has(node.tagName)) {
      return `<${node.tagName}>${presentNodes(node.childNodes, unitId)}</${node.tagName}>`;
    }

    if (node.tagName === "a") {
      return presentLink(node, unitId);
    }

    return presentNodes(node.childNodes, unitId);
  }

  function presentLink(link: Element, unitId: string | undefined): string {
    if (extractText(link).trim().length === 0) {
      return "";
    }

    const href = resolveLink({
      href: link.attrs.find((attribute) => attribute.name === "href")?.value,
      baseUrl,
    });
    const childrenHtml = presentNodes(link.childNodes, unitId);

    return href === undefined
      ? childrenHtml
      : `<a href="${escapeHtmlAttribute(href)}">${childrenHtml}</a>`;
  }

  return { html: presentNodes(fragment.childNodes, undefined), units };
}

/**
 * Moves the leading headings of a unit's `section` before the outermost list or blockquote that the
 * section opens, and gives each moved heading the section's unit ID.
 */
function moveHeadingsOutOfContainers(parentNode: ParentNode): void {
  // A copy, because moving headings inserts them among the children of an ancestor being visited.
  const childNodes = parentNode.childNodes.slice();

  for (const childNode of childNodes) {
    if (!("tagName" in childNode)) {
      continue;
    }

    if (childNode.tagName === "section") {
      moveLeadingHeadings(childNode);
    } else {
      moveHeadingsOutOfContainers(childNode);
    }
  }
}

function moveLeadingHeadings(section: Element): void {
  const unitIdAttribute = section.attrs.find((attribute) => attribute.name === "id");
  const headingContainer = findOutermostOpenedContainer(section);

  if (unitIdAttribute === undefined || headingContainer === undefined) {
    return;
  }

  const leadingHeadings: Element[] = [];

  for (const childNode of section.childNodes) {
    if (!("tagName" in childNode) || !HEADING_TAG_NAMES.has(childNode.tagName)) {
      break;
    }

    leadingHeadings.push(childNode);
  }

  const containerParent = headingContainer.parentNode!;

  section.childNodes = section.childNodes.slice(leadingHeadings.length);
  containerParent.childNodes.splice(
    containerParent.childNodes.indexOf(headingContainer),
    0,
    ...leadingHeadings,
  );

  for (const heading of leadingHeadings) {
    heading.parentNode = containerParent;
    heading.attrs = [{ name: "id", value: unitIdAttribute.value }];
  }
}

function findOutermostOpenedContainer(section: Element): Element | undefined {
  let headingContainer: Element | undefined;
  let node: Element = section;

  while (
    node.parentNode !== null &&
    "tagName" in node.parentNode &&
    CONTAINER_TAG_NAMES.has(node.parentNode.tagName) &&
    node.parentNode.childNodes[0] === node
  ) {
    node = node.parentNode;

    if (HEADING_CONTAINER_TAG_NAMES.has(node.tagName)) {
      headingContainer = node;
    }
  }

  return headingContainer;
}

function extractText(node: ChildNode): string {
  if ("value" in node) {
    return node.value;
  }

  return "childNodes" in node ? node.childNodes.map(extractText).join("") : "";
}
