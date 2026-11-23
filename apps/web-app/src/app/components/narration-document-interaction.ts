import { css } from "@linaria/core";

import { interTypefaceScope } from "#src/app/global-styles.js";

const POPOVER_MARGIN_PIXELS = 8;

const POPOVER_ARROW_INSET_PIXELS = 16;

export function attachNarrationDocumentInteraction({
  narrationDocumentElement,
  unitIds,
  selectUnit,
}: {
  narrationDocumentElement: HTMLElement;
  unitIds: readonly string[];
  selectUnit: ((unitIndex: number) => void) | undefined;
}): () => void {
  const unitIndexById = new Map(unitIds.map((unitId, unitIndex) => [unitId, unitIndex]));
  const linkPopover = createLinkPopover();

  const playFromHereButtons =
    selectUnit === undefined
      ? []
      : unitIds.map((unitId, unitIndex) =>
          addPlayFromHereButton(narrationDocumentElement, unitId, unitIndex),
        );
  if (selectUnit !== undefined) {
    narrationDocumentElement.classList.add(playableDocumentClassName);
  }

  const onClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    const link = event.target.closest("a[href]");
    if (link instanceof HTMLAnchorElement && narrationDocumentElement.contains(link)) {
      event.preventDefault();
      linkPopover.open(link, { isFromKeyboard: event.detail === 0 });
      return;
    }

    if (selectUnit === undefined) {
      return;
    }

    const playFromHereButton = event.target.closest<HTMLElement>("[data-play-from-here]");
    if (playFromHereButton) {
      selectUnit(Number(playFromHereButton.dataset["playFromHere"]));
      return;
    }

    const segmentElement = event.target.closest("[data-synchronization-unit]");
    const unitIndex = unitIndexById.get(
      segmentElement?.getAttribute("data-synchronization-unit") ?? "",
    );
    if (unitIndex === undefined) {
      return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      return;
    }
    selectUnit(unitIndex);
  };
  narrationDocumentElement.addEventListener("click", onClick);

  return () => {
    narrationDocumentElement.removeEventListener("click", onClick);
    narrationDocumentElement.classList.remove(playableDocumentClassName);
    for (const button of playFromHereButtons) {
      button.remove();
    }
    linkPopover.dispose();
  };
}

function addPlayFromHereButton(
  narrationDocumentElement: HTMLElement,
  unitId: string,
  unitIndex: number,
): HTMLButtonElement {
  const firstElement = narrationDocumentElement.querySelector(
    `[data-synchronization-unit="${CSS.escape(unitId)}"]`,
  );
  if (!firstElement) {
    throw new Error(`The narration document has no unit ${unitId}.`);
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = playFromHereButtonClassName;
  button.dataset["playFromHere"] = String(unitIndex);
  button.setAttribute("aria-label", "Play from here");

  if (/^H[1-6]$/.test(firstElement.tagName)) {
    const parent = firstElement.parentElement;
    (parent?.tagName === "HGROUP" ? parent : firstElement).before(button);
  } else if (firstElement instanceof HTMLTableRowElement && firstElement.cells[0]) {
    firstElement.cells[0].prepend(button);
  } else {
    firstElement.prepend(button);
  }
  return button;
}

type LinkPopover = {
  open: (link: HTMLAnchorElement, options: { isFromKeyboard: boolean }) => void;
  dispose: () => void;
};

function createLinkPopover(): LinkPopover {
  const backdrop = document.createElement("div");
  backdrop.className = backdropClassName;

  const popover = document.createElement("a");
  popover.className = popoverClassName;
  popover.target = "_blank";
  popover.rel = "noopener noreferrer";
  for (const [name, value] of Object.entries(interTypefaceScope)) {
    popover.setAttribute(name, value);
  }
  const label = document.createElement("span");
  label.className = popoverLabelClassName;
  label.textContent = "Open link ↗";
  const host = document.createElement("span");
  host.className = popoverHostClassName;
  popover.append(label, host);

  let openLink: HTMLAnchorElement | undefined;

  const close = ({ shouldRefocusLink }: { shouldRefocusLink: boolean }) => {
    if (!openLink) {
      return;
    }
    const link = openLink;
    openLink = undefined;
    link.classList.remove(openLinkClassName);
    backdrop.remove();
    popover.remove();
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("scroll", onScroll, { capture: true });
    if (shouldRefocusLink) {
      link.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      close({ shouldRefocusLink: true });
    }
  };
  const onScroll = () => close({ shouldRefocusLink: false });

  backdrop.addEventListener("click", () => close({ shouldRefocusLink: false }));
  popover.addEventListener("click", () => {
    window.setTimeout(() => close({ shouldRefocusLink: false }));
  });
  popover.addEventListener("focusout", (event) => {
    if (event.relatedTarget !== null && event.relatedTarget !== openLink) {
      close({ shouldRefocusLink: false });
    }
  });

  const open: LinkPopover["open"] = (link, { isFromKeyboard }) => {
    close({ shouldRefocusLink: false });
    openLink = link;
    link.classList.add(openLinkClassName);

    popover.href = link.href;
    host.textContent = new URL(link.href).host;
    popover.setAttribute(
      "aria-label",
      `Open link: ${link.textContent.trim()}, ${host.textContent}`,
    );
    document.body.append(backdrop, popover);
    placePopover(popover, link);

    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    if (isFromKeyboard) {
      popover.focus({ preventScroll: true });
    }
  };

  return { open, dispose: () => close({ shouldRefocusLink: false }) };
}

function placePopover(popover: HTMLElement, link: HTMLAnchorElement) {
  const lineRects = [...link.getClientRects()];
  const firstLineRect = lineRects.at(0) ?? link.getBoundingClientRect();
  const lastLineRect = lineRects.at(-1) ?? firstLineRect;
  const popoverRect = popover.getBoundingClientRect();

  const topBelow = lastLineRect.bottom + POPOVER_MARGIN_PIXELS;
  const fitsBelow = topBelow + popoverRect.height + POPOVER_MARGIN_PIXELS <= window.innerHeight;
  const anchorRect = fitsBelow ? lastLineRect : firstLineRect;
  const top = fitsBelow
    ? topBelow
    : Math.max(
        POPOVER_MARGIN_PIXELS,
        firstLineRect.top - POPOVER_MARGIN_PIXELS - popoverRect.height,
      );
  const left = Math.min(
    Math.max(POPOVER_MARGIN_PIXELS, anchorRect.left + anchorRect.width / 2 - popoverRect.width / 2),
    document.documentElement.clientWidth - popoverRect.width - POPOVER_MARGIN_PIXELS,
  );

  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
  const arrowX = Math.min(
    Math.max(POPOVER_ARROW_INSET_PIXELS, anchorRect.left + anchorRect.width / 2 - left),
    popoverRect.width - POPOVER_ARROW_INSET_PIXELS,
  );
  popover.style.setProperty("--link-popover-arrow-x", `${arrowX}px`);
  popover.dataset["placement"] = fitsBelow ? "below" : "above";
}

const playableDocumentClassName = css`
  [data-synchronization-unit] {
    cursor: pointer;
  }
`;

const playFromHereButtonClassName = css`
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  white-space: nowrap;
  border: 0;
  clip-path: inset(50%);

  &::before {
    content: "Play from here";
  }

  &:focus {
    z-index: 1;
    width: auto;
    height: auto;
    padding: 4px 12px;
    font-weight: 500;
    color: var(--color-page);
    background-color: var(--color-ink);
    border-radius: 999px;
    clip-path: none;
  }
`;

const openLinkClassName = css`
  background-color: var(--color-ink-8);
  border-radius: 4px;
  box-shadow: 0 0 0 2px var(--color-ink-8);
`;

const backdropClassName = css`
  position: fixed;
  inset: 0;
  z-index: 3;
`;

const popoverClassName = css`
  position: fixed;
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: calc(100vw - 16px);
  padding: 10px 14px;

  color: var(--color-page);
  text-decoration: none;
  background-color: var(--color-ink);
  border-radius: var(--spacing-gutter);
  box-shadow: 0 6px 20px rgb(0 0 0 / 25%);

  &::before {
    position: absolute;
    left: calc(var(--link-popover-arrow-x) - 6px);
    width: 12px;
    height: 12px;
    content: "";
    background-color: inherit;
    transform: rotate(45deg);
  }

  &[data-placement="below"]::before {
    top: -4px;
  }

  &[data-placement="above"]::before {
    bottom: -4px;
  }
`;

const popoverLabelClassName = css`
  font-weight: var(--font-weight-inter-figma-medium);
`;

const popoverHostClassName = css`
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--font-size-xs);
  white-space: nowrap;
  opacity: 0.7;
`;
