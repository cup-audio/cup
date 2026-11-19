/*
 * PROTOTYPE, throwaway (wayfinder ticket cup-audio/cup#481). Do not merge.
 *
 * Question: how does a listener start playback at a segment while inline content (links) stays
 * interactive and the reader stays accessible? Four variants of the reader's segment interaction,
 * switchable via `?variant=A|B|C|D` and the floating bar (or ← / →):
 *
 * A  Overlay (today): an invisible full-size button covers every segment; links can't be tapped.
 * B  Tap the text: the segment itself takes the tap; a tap on a link opens the link instead, and
 *    a text selection plays nothing. Keyboard and screen readers get a "Play from here" button per
 *    segment that stays invisible until focused.
 * C  Play-button gutter: a small visible play button sits in the inline-start margin of every
 *    segment; tapping the text does nothing, so text and links behave like any web page.
 * D  Select, then play: a tap marks the segment and shows a "Play from here" chip on it; a second
 *    action plays. Links open on tap.
 * E  Long-press: a tap does nothing special (links open); pressing and holding a segment fills it
 *    and plays from it. Keyboard and screen readers get B's focus-only button.
 * F  Overlay with links on top: today's overlay stays, but links are lifted above it, so a link
 *    tap opens the link and every other tap plays. Same buttons for screen readers as today.
 * G  Reading line: no per-segment controls at all. The segment crossing a reading line is marked
 *    as you scroll, and one "Play from here" pill above the player plays from it.
 * H  Segment sheet: a tap anywhere on a segment, link included, opens a sheet with "Play from
 *    here" and the segment's links; links are inert inline.
 * I  Link popover: a tap on a segment plays it, as today; a tap on a link plays nothing and opens
 *    a small "Open link" popover anchored to the link. Tapping the popover opens the link; tapping
 *    anywhere else (the backdrop) dismisses it. Keyboard and screen readers get B's focus-only
 *    play button, and a link activated from the keyboard opens the same popover.
 */
import React from "react";
import { createPortal } from "react-dom";

export const SEGMENT_PLAY_VARIANTS = {
  A: "Overlay (today)",
  B: "Tap the text",
  C: "Play-button gutter",
  D: "Select, then play",
  E: "Long-press",
  F: "Overlay, links on top",
  G: "Reading line",
  H: "Segment sheet",
  I: "Link popover",
} as const;
export type SegmentPlayVariant = keyof typeof SEGMENT_PLAY_VARIANTS;
const VARIANT_KEYS = Object.keys(SEGMENT_PLAY_VARIANTS) as SegmentPlayVariant[];
const VARIANT_CHANGE_EVENT = "prototype-segment-play-variant";

function readVariant(): SegmentPlayVariant {
  const value = new URLSearchParams(window.location.search).get("variant");
  return VARIANT_KEYS.find((key) => key === value) ?? "A";
}

function writeVariant(variant: SegmentPlayVariant) {
  const url = new URL(window.location.href);
  url.searchParams.set("variant", variant);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(VARIANT_CHANGE_EVENT));
}

export function useSegmentPlayVariant(): SegmentPlayVariant {
  return React.useSyncExternalStore((onChange) => {
    window.addEventListener(VARIANT_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(VARIANT_CHANGE_EVENT, onChange);
  }, readVariant);
}

const INTERACTIVE_SELECTOR = "a[href], button, input, select, textarea, summary, [tabindex]";

/** Attaches the variant's segment interaction to the rendered narration document. */
export function attachSegmentPlayback(
  variant: SegmentPlayVariant,
  documentElement: HTMLElement,
  segments: HTMLElement[],
  selectUnit: (unitIndex: number) => void,
): () => void {
  documentElement.dataset["prototypeVariant"] = variant;
  const cleanups: (() => void)[] = [() => delete documentElement.dataset["prototypeVariant"]];

  switch (variant) {
    case "A": {
      for (const [unitIndex, segment] of segments.entries()) {
        const button = createButton(`Play segment ${unitIndex + 1}`, "overlay");
        button.addEventListener("click", () => selectUnit(unitIndex));
        segment.append(button);
        cleanups.push(() => button.remove());
      }
      break;
    }

    case "B": {
      for (const [unitIndex, segment] of segments.entries()) {
        const onClick = (event: MouseEvent) => {
          if (isInsideInteractive(event.target, segment)) {
            return;
          }
          // Selecting text to copy it is not a request to play.
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed && segment.contains(selection.anchorNode)) {
            return;
          }
          selectUnit(unitIndex);
        };
        segment.addEventListener("click", onClick);
        segment.dataset["prototypeTappable"] = "";
        const button = createButton(`Play from segment ${unitIndex + 1}`, "skip-link");
        button.textContent = "▶ Play from here";
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          selectUnit(unitIndex);
        });
        segment.prepend(button);
        cleanups.push(() => {
          segment.removeEventListener("click", onClick);
          delete segment.dataset["prototypeTappable"];
          button.remove();
        });
      }
      break;
    }

    case "C": {
      for (const [unitIndex, segment] of segments.entries()) {
        const button = createButton(`Play from segment ${unitIndex + 1}`, "gutter");
        button.textContent = "▶";
        button.addEventListener("click", () => selectUnit(unitIndex));
        segment.prepend(button);
        cleanups.push(() => button.remove());
      }
      break;
    }

    case "D": {
      let selected: HTMLElement | undefined;
      const chip = createButton("Play from here", "chip");
      chip.textContent = "▶ Play from here";
      let selectedIndex = -1;
      chip.addEventListener("click", (event) => {
        event.stopPropagation();
        selectUnit(selectedIndex);
        clear();
      });
      const clear = () => {
        selected?.removeAttribute("data-prototype-selected");
        chip.remove();
        selected = undefined;
      };
      const choose = (segment: HTMLElement, unitIndex: number) => {
        clear();
        selected = segment;
        selectedIndex = unitIndex;
        segment.dataset["prototypeSelected"] = "";
        segment.append(chip);
      };
      for (const [unitIndex, segment] of segments.entries()) {
        // Keyboard and screen readers reach each segment as a focusable group.
        segment.tabIndex = 0;
        segment.setAttribute("role", "group");
        segment.setAttribute("aria-label", `Segment ${unitIndex + 1}, press Enter to choose`);
        const onClick = (event: MouseEvent) => {
          if (isInsideInteractive(event.target, segment)) {
            return;
          }
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) {
            return;
          }
          choose(segment, unitIndex);
        };
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.target === segment && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            choose(segment, unitIndex);
            chip.focus();
          }
        };
        segment.addEventListener("click", onClick);
        segment.addEventListener("keydown", onKeyDown);
        cleanups.push(() => {
          segment.removeEventListener("click", onClick);
          segment.removeEventListener("keydown", onKeyDown);
          segment.removeAttribute("tabindex");
          segment.removeAttribute("role");
          segment.removeAttribute("aria-label");
        });
      }
      cleanups.push(clear);
      break;
    }
    case "E": {
      const LONG_PRESS_MILLISECONDS = 450;
      for (const [unitIndex, segment] of segments.entries()) {
        let timer: number | undefined;
        let start: { x: number; y: number } | undefined;
        let fired = false;
        const cancel = () => {
          window.clearTimeout(timer);
          timer = undefined;
          delete segment.dataset["prototypePressing"];
        };
        const onPointerDown = (event: PointerEvent) => {
          if (isInsideInteractive(event.target, segment)) {
            return;
          }
          fired = false;
          start = { x: event.clientX, y: event.clientY };
          segment.dataset["prototypePressing"] = "";
          timer = window.setTimeout(() => {
            fired = true;
            cancel();
            navigator.vibrate?.(15);
            selectUnit(unitIndex);
          }, LONG_PRESS_MILLISECONDS);
        };
        const onPointerMove = (event: PointerEvent) => {
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
            cancel();
          }
        };
        // A long press otherwise opens the text selection or the context menu.
        const onContextMenu = (event: Event) => {
          if (fired || timer !== undefined) {
            event.preventDefault();
          }
        };
        segment.addEventListener("pointerdown", onPointerDown);
        segment.addEventListener("pointermove", onPointerMove);
        segment.addEventListener("pointerup", cancel);
        segment.addEventListener("pointercancel", cancel);
        segment.addEventListener("pointerleave", cancel);
        segment.addEventListener("contextmenu", onContextMenu);
        segment.dataset["prototypeLongPress"] = "";
        const button = createButton(`Play from segment ${unitIndex + 1}`, "skip-link");
        button.textContent = "▶ Play from here";
        button.addEventListener("click", () => selectUnit(unitIndex));
        segment.prepend(button);
        cleanups.push(() => {
          cancel();
          segment.removeEventListener("pointerdown", onPointerDown);
          segment.removeEventListener("pointermove", onPointerMove);
          segment.removeEventListener("pointerup", cancel);
          segment.removeEventListener("pointercancel", cancel);
          segment.removeEventListener("pointerleave", cancel);
          segment.removeEventListener("contextmenu", onContextMenu);
          delete segment.dataset["prototypeLongPress"];
          button.remove();
        });
      }
      break;
    }

    case "F": {
      for (const [unitIndex, segment] of segments.entries()) {
        const button = createButton(`Play segment ${unitIndex + 1}`, "overlay");
        button.addEventListener("click", () => selectUnit(unitIndex));
        segment.append(button);
        cleanups.push(() => button.remove());
      }
      break;
    }

    case "G": {
      const pill = createButton("", "reading-line-pill");
      const line = document.createElement("div");
      line.dataset["prototypeReadingLine"] = "";
      let readingIndex = 0;
      const update = () => {
        // The reading line sits a third down the screen.
        const lineY = window.innerHeight / 3;
        // The segment under the line, or the next one when the line falls between segments.
        const found = segments.findIndex(
          (segment) => segment.getBoundingClientRect().bottom > lineY,
        );
        const index = found === -1 ? segments.length - 1 : found;
        segments[readingIndex]?.removeAttribute("data-prototype-reading");
        readingIndex = index;
        const segment = segments[index];
        segment?.setAttribute("data-prototype-reading", "");
        const words = (segment?.textContent ?? "").trim().split(/\s+/).slice(0, 4).join(" ");
        pill.textContent = `▶ Play from “${words}…”`;
        pill.setAttribute("aria-label", `Play from segment ${index + 1}: ${words}`);
        pill.hidden = segment?.getAttribute("aria-current") === "true";
      };
      pill.addEventListener("click", () => {
        selectUnit(readingIndex);
        window.setTimeout(update, 100);
      });
      document.body.append(line, pill);
      window.addEventListener("scroll", update, { passive: true, capture: true });
      const observer = new MutationObserver(update);
      observer.observe(documentElement, {
        attributes: true,
        subtree: true,
        attributeFilter: ["aria-current"],
      });
      update();
      cleanups.push(() => {
        window.removeEventListener("scroll", update, { capture: true });
        observer.disconnect();
        segments[readingIndex]?.removeAttribute("data-prototype-reading");
        pill.remove();
        line.remove();
      });
      break;
    }

    case "H": {
      const sheet = document.createElement("div");
      sheet.dataset["prototypeSheet"] = "";
      sheet.setAttribute("role", "dialog");
      sheet.setAttribute("aria-label", "Segment");
      const backdrop = document.createElement("div");
      backdrop.dataset["prototypeBackdrop"] = "";
      let opener: HTMLElement | undefined;
      const close = () => {
        sheet.remove();
        backdrop.remove();
        opener?.removeAttribute("data-prototype-selected");
        opener?.focus();
        opener = undefined;
      };
      backdrop.addEventListener("click", close);
      const onEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape" && opener) {
          close();
        }
      };
      document.addEventListener("keydown", onEscape);
      const open = (segment: HTMLElement, unitIndex: number) => {
        opener = segment;
        segment.dataset["prototypeSelected"] = "";
        sheet.replaceChildren();
        const play = document.createElement("button");
        play.type = "button";
        play.textContent = "▶ Play from here";
        play.addEventListener("click", () => {
          selectUnit(unitIndex);
          close();
        });
        sheet.append(play);
        for (const link of segment.querySelectorAll<HTMLAnchorElement>("a[href]")) {
          const item = document.createElement("a");
          item.href = link.href;
          item.target = "_blank";
          item.rel = "noopener noreferrer";
          item.textContent = `↗ ${link.textContent ?? link.href}`;
          const host = document.createElement("small");
          host.textContent = new URL(link.href).host;
          item.append(host);
          sheet.append(item);
        }
        document.body.append(backdrop, sheet);
        play.focus();
      };
      for (const [unitIndex, segment] of segments.entries()) {
        segment.tabIndex = 0;
        segment.setAttribute("role", "button");
        segment.setAttribute("aria-haspopup", "dialog");
        const links = segment.querySelectorAll("a[href]");
        for (const link of links) {
          link.setAttribute("tabindex", "-1");
        }
        const onClick = (event: MouseEvent) => {
          event.preventDefault();
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) {
            return;
          }
          open(segment, unitIndex);
        };
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.target === segment && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            open(segment, unitIndex);
          }
        };
        segment.addEventListener("click", onClick);
        segment.addEventListener("keydown", onKeyDown);
        cleanups.push(() => {
          segment.removeEventListener("click", onClick);
          segment.removeEventListener("keydown", onKeyDown);
          segment.removeAttribute("tabindex");
          segment.removeAttribute("role");
          segment.removeAttribute("aria-haspopup");
          for (const link of links) {
            link.removeAttribute("tabindex");
          }
        });
      }
      cleanups.push(() => {
        document.removeEventListener("keydown", onEscape);
        sheet.remove();
        backdrop.remove();
      });
      break;
    }
    case "I": {
      const backdrop = document.createElement("div");
      backdrop.dataset["prototypePopoverBackdrop"] = "";
      const popover = document.createElement("a");
      popover.dataset["prototypeLinkPopover"] = "";
      popover.target = "_blank";
      popover.rel = "noopener noreferrer";
      let anchor: HTMLAnchorElement | undefined;
      const close = (refocus: boolean) => {
        anchor?.removeAttribute("data-prototype-link-open");
        if (refocus) {
          anchor?.focus();
        }
        anchor = undefined;
        popover.remove();
        backdrop.remove();
      };
      const open = (link: HTMLAnchorElement, fromKeyboard: boolean) => {
        anchor = link;
        link.dataset["prototypeLinkOpen"] = "";
        popover.href = link.href;
        popover.replaceChildren();
        const label = document.createElement("strong");
        label.textContent = "Open link ↗";
        const host = document.createElement("small");
        host.textContent = new URL(link.href).host;
        popover.append(label, host);
        popover.setAttribute(
          "aria-label",
          `Open link: ${link.textContent ?? ""}, ${host.textContent}`,
        );
        document.body.append(backdrop, popover);
        // Above the link, or below it when the link is near the top of the screen.
        const linkRect = link.getClientRects()[0] ?? link.getBoundingClientRect();
        const popoverRect = popover.getBoundingClientRect();
        const margin = 8;
        const left = Math.min(
          Math.max(margin, linkRect.left + linkRect.width / 2 - popoverRect.width / 2),
          window.innerWidth - popoverRect.width - margin,
        );
        const above = linkRect.top - popoverRect.height - margin > 80;
        popover.style.left = `${left}px`;
        popover.style.top = `${above ? linkRect.top - popoverRect.height - margin : linkRect.bottom + margin}px`;
        popover.dataset["placement"] = above ? "above" : "below";
        if (fromKeyboard) {
          popover.focus();
        }
      };
      // The backdrop takes the dismissing tap, so it never reaches a segment and plays nothing.
      backdrop.addEventListener("click", () => close(false));
      popover.addEventListener("click", () => close(false));
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && anchor) {
          close(true);
        }
      };
      const onScroll = () => anchor && close(false);
      document.addEventListener("keydown", onKeyDown);
      window.addEventListener("scroll", onScroll, { passive: true, capture: true });
      for (const [unitIndex, segment] of segments.entries()) {
        const onClick = (event: MouseEvent) => {
          const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
          if (link instanceof HTMLAnchorElement && segment.contains(link)) {
            event.preventDefault();
            // A click without a pointer position comes from the keyboard.
            open(link, event.detail === 0);
            return;
          }
          if (isInsideInteractive(event.target, segment)) {
            return;
          }
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed && segment.contains(selection.anchorNode)) {
            return;
          }
          selectUnit(unitIndex);
        };
        segment.addEventListener("click", onClick);
        segment.dataset["prototypeTappable"] = "";
        const button = createButton(`Play from segment ${unitIndex + 1}`, "skip-link");
        button.textContent = "▶ Play from here";
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          selectUnit(unitIndex);
        });
        segment.prepend(button);
        cleanups.push(() => {
          segment.removeEventListener("click", onClick);
          delete segment.dataset["prototypeTappable"];
          button.remove();
        });
      }
      cleanups.push(() => {
        document.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("scroll", onScroll, { capture: true });
        close(false);
      });
      break;
    }
  }

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}

function createButton(label: string, kind: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset["prototypeControl"] = kind;
  button.setAttribute("aria-label", label);
  return button;
}

function isInsideInteractive(target: EventTarget | null, segment: HTMLElement) {
  if (!(target instanceof Element)) {
    return false;
  }
  const interactive = target.closest(INTERACTIVE_SELECTOR);
  return interactive !== null && interactive !== segment && segment.contains(interactive);
}

/** Global styles for the variants, plus the floating switcher. */
export function SegmentPlayPrototypeChrome() {
  const variant = useSegmentPlayVariant();

  React.useEffect(function cycleWithArrowKeys() {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        cycle(event.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return createPortal(
    <>
      <style>{PROTOTYPE_CSS}</style>
      <div data-prototype-switcher="">
        <button type="button" aria-label="Previous variant" onClick={() => cycle(-1)}>
          ←
        </button>
        <span>
          {variant} ({SEGMENT_PLAY_VARIANTS[variant]})
        </span>
        <button type="button" aria-label="Next variant" onClick={() => cycle(1)}>
          →
        </button>
      </div>
    </>,
    document.body,
  );
}

function cycle(step: number) {
  const index = VARIANT_KEYS.indexOf(readVariant());
  const next = VARIANT_KEYS[(index + step + VARIANT_KEYS.length) % VARIANT_KEYS.length];
  if (next) {
    writeVariant(next);
  }
}

const PROTOTYPE_CSS = `
[data-prototype-switcher] {
  position: fixed; z-index: 10000; inset-block-start: 8px; inset-inline-start: 50%;
  transform: translateX(-50%); display: flex; gap: 12px; align-items: center;
  padding: 8px 14px; border-radius: 999px; background: #111; color: #fff;
  font: 600 14px/1.2 system-ui, sans-serif; white-space: nowrap; box-shadow: 0 4px 16px rgb(0 0 0 / 35%);
}
[data-prototype-switcher] button {
  border: 0; background: #333; color: #fff; border-radius: 999px; width: 32px; height: 32px;
  font: inherit; cursor: pointer;
}

/* the narration document's links, visible in every variant */
[data-prototype-variant] a[href] { color: var(--color-ink); text-decoration: underline; }

/* A: today's overlay */
[data-prototype-variant] [id]:has(> [data-prototype-control="overlay"]) { position: relative; }

/* F: links lifted above the overlay */
[data-prototype-variant="F"] a[href] { position: relative; z-index: 1; }

/* E: long-press fills the segment while held */
[data-prototype-long-press] { position: relative; -webkit-touch-callout: none; }
[data-prototype-pressing] {
  border-radius: 12px; transition: background-color 450ms linear, box-shadow 450ms linear;
  background-color: var(--color-ink-20, #ddd); box-shadow: 0 0 0 12px var(--color-ink-20, #ddd);
}

/* G: reading line and one pill above the player */
[data-prototype-reading-line] {
  position: fixed; inset-inline: 0; inset-block-start: 33.3vh; height: 0; z-index: 9999;
  border-block-start: 1px dashed rgb(0 0 0 / 15%); pointer-events: none;
}
[data-prototype-reading] { border-inline-start: 3px solid var(--color-ink); padding-inline-start: 9px; margin-inline-start: -12px; }
[data-prototype-control="reading-line-pill"] {
  position: fixed; z-index: 9999; inset-block-end: 150px; inset-inline-start: 50%; transform: translateX(-50%);
  max-width: calc(100vw - 32px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 10px 16px; border-radius: 999px; border: 0; background: var(--color-ink); color: var(--color-paper, #fff);
  font: 600 14px/1.2 system-ui, sans-serif; cursor: pointer; box-shadow: 0 2px 10px rgb(0 0 0 / 25%);
}
[data-prototype-control="reading-line-pill"][hidden] { display: none; }

/* I: link popover */
[data-prototype-popover-backdrop] { position: fixed; inset: 0; z-index: 9998; background: transparent; }
[data-prototype-link-open] { background: var(--color-ink-20, #ddd); border-radius: 4px; box-shadow: 0 0 0 3px var(--color-ink-20, #ddd); }
[data-prototype-link-popover] {
  position: fixed; z-index: 9999; display: flex; flex-direction: column; gap: 2px;
  padding: 10px 14px; border-radius: 12px; background: var(--color-ink); color: var(--color-paper, #fff);
  text-decoration: none; font: 500 15px/1.2 system-ui, sans-serif; box-shadow: 0 4px 16px rgb(0 0 0 / 30%);
  max-width: calc(100vw - 16px);
}
[data-prototype-link-popover] small { opacity: 0.7; font-size: 12px; }

/* H: segment sheet */
[data-prototype-variant="H"] [role="button"] { cursor: pointer; }
[data-prototype-variant="H"] a[href] { pointer-events: none; }
[data-prototype-backdrop] { position: fixed; inset: 0; z-index: 9998; background: rgb(0 0 0 / 25%); }
[data-prototype-sheet] {
  position: fixed; z-index: 9999; inset-inline: 0; inset-block-end: 0; display: flex; flex-direction: column;
  gap: 4px; padding: 16px 16px 32px; border-radius: 20px 20px 0 0; background: var(--color-paper, #fff);
  box-shadow: 0 -4px 24px rgb(0 0 0 / 20%); font: 500 16px/1.3 system-ui, sans-serif;
}
[data-prototype-sheet] > * {
  display: flex; flex-direction: column; align-items: flex-start; padding: 12px; border-radius: 12px;
  border: 0; background: transparent; color: var(--color-ink); text-decoration: none; font: inherit; text-align: start; cursor: pointer;
}
[data-prototype-sheet] > button { background: var(--color-ink); color: var(--color-paper, #fff); font-weight: 600; }
[data-prototype-sheet] small { color: var(--color-ink-60); font-size: 13px; }
[data-prototype-control="overlay"] {
  position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; cursor: pointer;
  background: transparent; border: 0; border-radius: inherit;
}

/* B: tap the text; a focus-only button for keyboard and screen readers */
[data-prototype-tappable] { cursor: pointer; position: relative; }
[data-prototype-tappable]:hover { background-color: var(--color-ink-8); border-radius: 12px; box-shadow: 0 0 0 12px var(--color-ink-8); }
[data-prototype-control="skip-link"] {
  position: absolute; inset-block-start: -8px; inset-inline-start: 0; z-index: 1;
  clip-path: inset(50%); width: 1px; height: 1px; overflow: hidden; white-space: nowrap;
}
[data-prototype-control="skip-link"]:focus-visible {
  clip-path: none; width: auto; height: auto; padding: 4px 10px; border-radius: 999px;
  background: var(--color-ink); color: var(--color-paper, #fff); border: 0;
}

/* C: visible play button in the inline-start margin */
[data-prototype-variant="C"] [id]:has(> [data-prototype-control="gutter"]) { position: relative; }
[data-prototype-control="gutter"] {
  position: absolute; inset-inline-start: -34px; inset-block-start: 0; width: 28px; height: 28px;
  border-radius: 999px; border: 1px solid var(--color-ink-20, #ccc); background: transparent;
  color: var(--color-ink-60); font-size: 11px; cursor: pointer; padding: 0;
}
[data-prototype-control="gutter"]:hover, [data-prototype-control="gutter"]:focus-visible {
  background: var(--color-ink); color: var(--color-paper, #fff);
}
[data-prototype-variant="C"] { padding-inline-start: 22px; }

/* D: select, then play */
[data-prototype-variant="D"] [role="group"] { cursor: pointer; position: relative; }
[data-prototype-selected] {
  outline: 2px solid var(--color-ink); outline-offset: 10px; border-radius: 12px;
}
[data-prototype-control="chip"] {
  position: absolute; inset-block-end: -30px; inset-inline-end: 0; z-index: 1;
  padding: 6px 12px; border-radius: 999px; border: 0; background: var(--color-ink);
  color: var(--color-paper, #fff); font: 600 13px/1 system-ui, sans-serif; cursor: pointer;
  box-shadow: 0 2px 8px rgb(0 0 0 / 25%);
}
`;
