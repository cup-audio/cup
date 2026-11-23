import { parseFragment, serialize } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import type { Tagged } from "type-fest";

import { CupError } from "@cup/errors";

export const SOURCE_ELEMENT_ID_ATTRIBUTE = "data-createaudiobookfromurl-element-id";

export type SourceElementIds = Tagged<readonly string[], "SourceElementIds">;

export type AnnotatedSource = {
  html: string;
  elementIds: string[];
};

export async function annotateSourceElements(sourceMaterialHtml: string): Promise<AnnotatedSource> {
  const documentFragment = parseFragment(sourceMaterialHtml);
  let nextElementId = 0;
  const elementIds: string[] = [];

  visitElements(documentFragment, (element) => {
    const elementId = String(nextElementId);
    const existingElementIdAttribute = element.attrs.find(
      (attribute) => attribute.name === SOURCE_ELEMENT_ID_ATTRIBUTE,
    );

    if (existingElementIdAttribute) {
      existingElementIdAttribute.value = elementId;
    } else {
      element.attrs.push({
        name: SOURCE_ELEMENT_ID_ATTRIBUTE,
        value: elementId,
      });
    }

    elementIds.push(elementId);
    nextElementId += 1;
  });

  return { html: serialize(documentFragment), elementIds };
}

export async function filterSourceByElementIds({
  annotatedSourceMaterial,
  selectedElementIds,
}: {
  annotatedSourceMaterial: AnnotatedSource;
  selectedElementIds: SourceElementIds;
}): Promise<string> {
  const selectedElementIdSet = new Set(selectedElementIds);
  const elementIdsToKeep = new Set(selectedElementIds);
  const documentFragment = parseFragment(annotatedSourceMaterial.html);

  collectElementIdsToKeep(documentFragment, selectedElementIdSet, elementIdsToKeep, []);
  removeUnselectedContent(documentFragment, selectedElementIdSet, elementIdsToKeep, false);

  return serialize(documentFragment);
}

function visitElements(
  parentNode: DefaultTreeAdapterMap["parentNode"],
  visitor: (element: DefaultTreeAdapterMap["element"]) => void,
): void {
  for (const childNode of parentNode.childNodes) {
    if (!("tagName" in childNode)) {
      continue;
    }

    visitor(childNode);
    visitElements(getElementContent(childNode), visitor);
  }
}

function collectElementIdsToKeep(
  parentNode: DefaultTreeAdapterMap["parentNode"],
  selectedElementIds: ReadonlySet<string>,
  elementIdsToKeep: Set<string>,
  ancestorElementIds: readonly string[],
): void {
  for (const childNode of parentNode.childNodes) {
    if (!("tagName" in childNode)) {
      continue;
    }

    const elementId = getElementId(childNode);

    if (selectedElementIds.has(elementId)) {
      for (const ancestorElementId of ancestorElementIds) {
        elementIdsToKeep.add(ancestorElementId);
      }
    }

    collectElementIdsToKeep(getElementContent(childNode), selectedElementIds, elementIdsToKeep, [
      ...ancestorElementIds,
      elementId,
    ]);
  }
}

function removeUnselectedContent(
  parentNode: DefaultTreeAdapterMap["parentNode"],
  selectedElementIds: ReadonlySet<string>,
  elementIdsToKeep: ReadonlySet<string>,
  isWithinSelectedElement: boolean,
): void {
  parentNode.childNodes = parentNode.childNodes.filter((childNode) => {
    if (childNode.nodeName === "#text") {
      return isWithinSelectedElement;
    }

    if (!("tagName" in childNode)) {
      return true;
    }

    const elementId = getElementId(childNode);
    const isSelectedElement = selectedElementIds.has(elementId);
    const shouldKeepElement = isWithinSelectedElement || elementIdsToKeep.has(elementId);

    if (!shouldKeepElement) {
      return false;
    }

    removeUnselectedContent(
      getElementContent(childNode),
      selectedElementIds,
      elementIdsToKeep,
      isWithinSelectedElement || isSelectedElement,
    );

    return true;
  });
}

function getElementContent(
  element: DefaultTreeAdapterMap["element"],
): DefaultTreeAdapterMap["parentNode"] {
  return isTemplateElement(element) ? element.content : element;
}

function isTemplateElement(
  element: DefaultTreeAdapterMap["element"],
): element is DefaultTreeAdapterMap["template"] {
  return element.tagName === "template" && "content" in element;
}

function getElementId(element: DefaultTreeAdapterMap["element"]): string {
  const elementId = element.attrs.find(
    (attribute) => attribute.name === SOURCE_ELEMENT_ID_ATTRIBUTE,
  )?.value;

  if (elementId === undefined) {
    throw new CupError(
      `Expected every HTML element to have a ${SOURCE_ELEMENT_ID_ATTRIBUTE} attribute`,
    );
  }

  return elementId;
}
