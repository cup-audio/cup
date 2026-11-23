import { check } from "@patricktree-stack/utils-ecma/assert.utils";
import React from "react";

export function useMasonryRowSpans(): React.RefCallback<HTMLElement> {
  return React.useCallback((list: HTMLElement | null) => {
    check.assert(list, "A ref callback with a cleanup is never called with null.");

    const spanMeasuredHeights = (items: Iterable<Element>) => {
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      for (const item of items) {
        if (item instanceof HTMLElement) {
          const height = item.getBoundingClientRect().height;
          item.style.gridRowEnd = `span ${Math.ceil(height + gap)}`;
        }
      }
    };

    spanMeasuredHeights(list.children);

    const resizeObserver = new ResizeObserver((entries) => {
      spanMeasuredHeights(entries.map((entry) => entry.target));
    });
    for (const item of list.children) {
      resizeObserver.observe(item);
    }

    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) {
            resizeObserver.observe(node);
          }
        }
        for (const node of record.removedNodes) {
          if (node instanceof Element) {
            resizeObserver.unobserve(node);
          }
        }
      }
    });
    mutationObserver.observe(list, { childList: true });

    list.dataset["masonry"] = "";

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      delete list.dataset["masonry"];
    };
  }, []);
}
