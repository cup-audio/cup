import { check } from "@patricktree-stack/utils-ecma/assert.utils";
import React from "react";

export function useIsInScrollReach(): [React.RefCallback<HTMLElement>, boolean] {
  const [isInReach, setIsInReach] = React.useState(false);

  const ref = React.useCallback((element: HTMLElement | null) => {
    check.assert(element, "A ref callback with a cleanup is never called with null.");

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry) {
          setIsInReach(entry.isIntersecting);
        }
      },
      {
        root: findScrollContainer(element),
        rootMargin: "100% 0px",
      },
    );
    observer.observe(element);

    return () => {
      observer.disconnect();
      setIsInReach(false);
    };
  }, []);

  return [ref, isInReach];
}

function findScrollContainer(element: HTMLElement): HTMLElement | null {
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const { overflowY } = getComputedStyle(ancestor);
    if (overflowY === "auto" || overflowY === "scroll") {
      return ancestor;
    }
  }

  return null;
}
