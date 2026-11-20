import { css } from "@linaria/core";

/** Space kept between the link popover and its link, and between the popover and the screen edge. */
const POPOVER_MARGIN_PIXELS = 8;

/**
 * Makes the rendered narration document interactive: a tap on a segment's text plays from it, a tap
 * on a link opens the "Open link" popover instead, and each segment gets a "Play from here" button
 * that is visible only while focused. Without `selectUnit` nothing plays, and links still open
 * through the popover. Returns the function that undoes it.
 */
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
      // A click without a pointer position comes from the keyboard.
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
    // The click that ends a text selection is not a request to play.
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

/** Adds a segment's button before its text, once per segment, however many elements it spans. */
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

  // Inside a heading the button would become part of the heading's name, and an <hgroup> holds
  // only headings and paragraphs, so a heading's button goes before it, or before its <hgroup>.
  if (/^H[1-6]$/.test(firstElement.tagName)) {
    const parent = firstElement.parentElement;
    (parent?.tagName === "HGROUP" ? parent : firstElement).before(button);
  } else {
    firstElement.prepend(button);
  }
  return button;
}

type LinkPopover = {
  open: (link: HTMLAnchorElement, options: { isFromKeyboard: boolean }) => void;
  dispose: () => void;
};

/**
 * The popover over the page that opens a link of the narration document. It is a real link, so it
 * opens the way the top bar's "Open original page" does: a new tab, or the system browser in the
 * shells. A transparent backdrop under it takes every other tap, so closing it plays nothing.
 */
function createLinkPopover(): LinkPopover {
  const backdrop = document.createElement("div");
  backdrop.className = backdropClassName;

  const popover = document.createElement("a");
  popover.className = popoverClassName;
  popover.target = "_blank";
  popover.rel = "noopener noreferrer";
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
  // Any scroll, of the page or of a scrolling block, moves the link away from the popover.
  const onScroll = () => close({ shouldRefocusLink: false });

  backdrop.addEventListener("click", () => close({ shouldRefocusLink: false }));
  popover.addEventListener("click", () => {
    // A link removed from the page during its click no longer navigates, so it closes afterwards.
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

/** Below the link, or above it when there is no room below, and always within the screen. */
function placePopover(popover: HTMLElement, link: HTMLAnchorElement) {
  // A link that wraps has a box per line: the popover points at its last line, or at its first
  // when placed above.
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
  popover.dataset["placement"] = fitsBelow ? "below" : "above";
}

const playableDocumentClassName = css`
  [data-synchronization-unit] {
    cursor: pointer;
  }
`;

/* visually hidden until focused, as `visuallyHidden` hides; in the static position, before the text */
const playFromHereButtonClassName = css`
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  white-space: nowrap;
  border: 0;
  clip-path: inset(50%);

  /* the label is drawn, not written into the page, so copied text and text matches leave it out */
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

/* above the shell's sticky bars and the mini player, so a tap on them closes the popover too */
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
  border-radius: 12px;
  box-shadow: 0 4px 16px rgb(0 0 0 / 30%);
`;

const popoverLabelClassName = css`
  font-weight: 500;
`;

const popoverHostClassName = css`
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  white-space: nowrap;
  opacity: 0.7;
`;
