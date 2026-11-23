import type { DefaultTreeAdapterMap } from "parse5";

export type HtmlElement = DefaultTreeAdapterMap["element"];
export type HtmlParentNode = DefaultTreeAdapterMap["parentNode"];

export type Metadata = { property: string; content: string };

export const NARRATION_TEXT_ELEMENT_TAG_NAMES = new Set<string>([
  "blockquote",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "p",
  "pre",
  "td",
  "th",
]);

type FindFirstElementOptions = {
  shouldDescend?: (element: HtmlElement) => boolean;
};

export function getAttribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}

function getChildElements(parentNode: HtmlParentNode): HtmlElement[] {
  const contentNode =
    "tagName" in parentNode && isTemplateElement(parentNode) ? parentNode.content : parentNode;

  return contentNode.childNodes.filter((childNode) => "tagName" in childNode);
}

export function findFirstElement(
  parentNode: HtmlParentNode,
  isMatch: (element: HtmlElement) => boolean,
  { shouldDescend = () => true }: FindFirstElementOptions = {},
): HtmlElement | undefined {
  for (const childElement of getChildElements(parentNode)) {
    if (isMatch(childElement)) {
      return childElement;
    }

    const descendant = shouldDescend(childElement)
      ? findFirstElement(childElement, isMatch, { shouldDescend })
      : undefined;

    if (descendant) {
      return descendant;
    }
  }

  return undefined;
}

export function findAllElements(
  parentNode: HtmlParentNode,
  isMatch: (element: HtmlElement) => boolean,
): HtmlElement[] {
  return getChildElements(parentNode).flatMap((childElement) => [
    ...(isMatch(childElement) ? [childElement] : []),
    ...findAllElements(childElement, isMatch),
  ]);
}

export function extractNodeText(
  parentNode: HtmlParentNode,
  isExcluded: (element: HtmlElement) => boolean = () => false,
): string {
  return parentNode.childNodes
    .map((childNode) => {
      if ("value" in childNode) {
        return childNode.value;
      }

      if (!("tagName" in childNode)) {
        return "";
      }

      return isExcluded(childNode) ? " " : extractNodeText(childNode, isExcluded);
    })
    .join("");
}

export function collectMetadata(parentNode: HtmlParentNode): Metadata[] {
  return findAllElements(parentNode, (element) => element.tagName === "meta").flatMap(
    (metaElement) => {
      const property = (getAttribute(metaElement, "property") ?? getAttribute(metaElement, "name"))
        ?.trim()
        .toLowerCase();
      const content = normalizeWhitespace(getAttribute(metaElement, "content") ?? "");

      return property && content.length > 0 ? [{ property, content }] : [];
    },
  );
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function isTemplateElement(
  element: HtmlElement,
): element is DefaultTreeAdapterMap["template"] {
  return element.tagName === "template" && "content" in element;
}
