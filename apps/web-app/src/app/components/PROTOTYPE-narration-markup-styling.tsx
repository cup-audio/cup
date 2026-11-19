/**
 * PROTOTYPE, throwaway, never merge. Wayfinder ticket cup-audio/cup#491: how does the reader style
 * the markup the narration document now keeps? Three variants of the reader's styles for links and
 * the "Open link" popover, inline markup (emphasis, code-like, s/del, q, sub/sup), the restored
 * tables, pre and dl, and the segment highlight across units spanning several elements
 * (`data-synchronization-unit`). Switch via `?variant=A|B|C`, the floating bar, or ← / →.
 *
 * - A "Faithful, scroll wide": browser-like structure, wide tables and pre scroll sideways, each
 *   element of a unit gets its own highlight bubble.
 * - B "Reflow, nothing scrolls": everything wraps to the column; at phone width table rows stack
 *   into blocks, pre wraps; the highlight is a bar in the margin.
 * - C "Cards, mono accents": tables and pre sit on surface cards that scroll with a sticky first
 *   column; code-like markup in Space Mono; the highlight is one continuous block across elements.
 */
import React from "react";
import { createPortal } from "react-dom";

export const MARKUP_STYLING_VARIANTS = {
  A: "Faithful, scroll wide",
  B: "Reflow, nothing scrolls",
  C: "Cards, mono accents",
} as const;
export type MarkupStylingVariant = keyof typeof MARKUP_STYLING_VARIANTS;
const VARIANT_KEYS = Object.keys(MARKUP_STYLING_VARIANTS) as MarkupStylingVariant[];
const VARIANT_CHANGE_EVENT = "prototype-markup-styling-variant";

function readVariant(): MarkupStylingVariant {
  const value = new URLSearchParams(window.location.search).get("variant");
  return VARIANT_KEYS.find((key) => key === value) ?? "A";
}

function writeVariant(variant: MarkupStylingVariant) {
  const url = new URL(window.location.href);
  url.searchParams.set("variant", variant);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(VARIANT_CHANGE_EVENT));
}

export function useMarkupStylingVariant(): MarkupStylingVariant {
  return React.useSyncExternalStore((onChange) => {
    window.addEventListener(VARIANT_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(VARIANT_CHANGE_EVENT, onChange);
  }, readVariant);
}

/** All elements of a unit, the way the renderer marks them. */
export function findUnitElements(root: ParentNode, unitId: string): Element[] {
  return [...root.querySelectorAll(`[data-synchronization-unit="${CSS.escape(unitId)}"]`)];
}

/**
 * Attaches the decided interaction (text tap plays, link tap opens the "Open link" popover) and the
 * variant's structure to the rendered narration document.
 */
export function attachMarkupPrototype(
  variant: MarkupStylingVariant,
  documentElement: HTMLElement,
  unitIds: readonly string[],
  selectUnit: ((unitIndex: number) => void) | undefined,
): () => void {
  documentElement.dataset["prototypeVariant"] = variant;
  documentElement.classList.add("cup-proto");

  // Position of each element within its unit, so a variant can draw one continuous highlight.
  const parted: Element[] = [];
  for (const unitId of unitIds) {
    const elements = findUnitElements(documentElement, unitId);
    elements.forEach((element, index) => {
      element.setAttribute(
        "data-unit-part",
        elements.length === 1
          ? "only"
          : index === 0
            ? "first"
            : index === elements.length - 1
              ? "last"
              : "middle",
      );
      parted.push(element);
    });
  }

  // Wide blocks get a wrapper, which a variant may make a scroll container or a card.
  const wrappers = [...documentElement.querySelectorAll("table, pre")].map((block) => {
    const wrapper = document.createElement("div");
    wrapper.dataset["protoBlock"] = block.tagName.toLowerCase();
    block.before(wrapper);
    wrapper.append(block);
    return wrapper;
  });

  let closePopover: (() => void) | undefined;
  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest("a[href]");
    if (link instanceof HTMLAnchorElement) {
      event.preventDefault();
      closePopover?.();
      closePopover = openLinkPopover(variant, link, () => (closePopover = undefined));
      return;
    }
    if (window.getSelection()?.isCollapsed === false) {
      return;
    }
    const unitElement = target?.closest("[data-synchronization-unit]");
    const unitId = unitElement?.getAttribute("data-synchronization-unit");
    const unitIndex = unitId ? unitIds.indexOf(unitId) : -1;
    if (unitIndex >= 0) {
      selectUnit?.(unitIndex);
    }
  };
  documentElement.addEventListener("click", onClick);

  return () => {
    closePopover?.();
    documentElement.removeEventListener("click", onClick);
    for (const wrapper of wrappers) {
      wrapper.replaceWith(...wrapper.childNodes);
    }
    for (const element of parted) {
      element.removeAttribute("data-unit-part");
    }
    documentElement.classList.remove("cup-proto");
    delete documentElement.dataset["prototypeVariant"];
  };
}

function openLinkPopover(
  variant: MarkupStylingVariant,
  link: HTMLAnchorElement,
  onClosed: () => void,
): () => void {
  const host = new URL(link.href).host;
  const backdrop = document.createElement("div");
  backdrop.dataset["protoBackdrop"] = "";
  const popover = document.createElement("div");
  popover.dataset["protoPopover"] = variant;
  if (variant !== "C") {
    popover.dataset["typeface"] = "inter";
  }
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Open link");

  const open = document.createElement("a");
  open.href = link.href;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  const label = document.createElement("span");
  label.dataset["protoLabel"] = "";
  label.textContent = "Open link ↗";
  const hostLine = document.createElement("span");
  hostLine.dataset["protoHost"] = "";
  hostLine.textContent = host;
  // B shows where the link goes first, then the action.
  if (variant === "B") {
    open.append(hostLine, label);
  } else {
    open.append(label, hostLine);
  }
  popover.append(open);

  const close = () => {
    backdrop.remove();
    popover.remove();
    link.removeAttribute("data-proto-open");
    window.removeEventListener("scroll", close, true);
    onClosed();
  };
  backdrop.addEventListener("click", close);
  open.addEventListener("click", () => setTimeout(close));
  window.addEventListener("scroll", close, true);

  link.setAttribute("data-proto-open", "");
  document.body.append(backdrop, popover);
  const rect = link.getClientRects()[0] ?? link.getBoundingClientRect();
  const width = popover.offsetWidth;
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - width / 2),
    window.innerWidth - width - 8,
  );
  const below = rect.bottom + 8 + popover.offsetHeight < window.innerHeight;
  popover.style.left = `${left}px`;
  popover.style.top = below
    ? `${rect.bottom + 8}px`
    : `${rect.top - 8 - popover.offsetHeight}px`;
  popover.style.setProperty(
    "--arrow-x",
    `${Math.min(Math.max(16, rect.left + rect.width / 2 - left), width - 16)}px`,
  );
  popover.dataset["protoSide"] = below ? "below" : "above";
  open.focus({ preventScroll: true });
  return close;
}

/** Global styles for the variants, plus the floating switcher. */
export function MarkupStylingPrototypeChrome() {
  const variant = useMarkupStylingVariant();

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

  if (import.meta.env.PROD) {
    return null;
  }

  return createPortal(
    <>
      <style>{PROTOTYPE_CSS}</style>
      <div data-prototype-switcher="">
        <button type="button" aria-label="Previous variant" onClick={() => cycle(-1)}>
          ←
        </button>
        <span>
          {variant} ({MARKUP_STYLING_VARIANTS[variant]})
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

const A = `.cup-proto[data-prototype-variant="A"]`;
const B = `.cup-proto[data-prototype-variant="B"]`;
const C = `.cup-proto[data-prototype-variant="C"]`;

const PROTOTYPE_CSS = `
[data-prototype-switcher] {
  position: fixed; z-index: 10000; inset-block-end: 96px; inset-inline-start: 50%;
  transform: translateX(-50%); display: flex; gap: 12px; align-items: center;
  padding: 8px 14px; border-radius: 999px; background: #c2185b; color: #fff;
  font: 600 14px/1.2 system-ui, sans-serif; white-space: nowrap; box-shadow: 0 4px 16px rgb(0 0 0 / 35%);
}
[data-prototype-switcher] button {
  border: 0; background: rgb(255 255 255 / 20%); color: #fff; border-radius: 999px; width: 32px; height: 32px;
  font: inherit; cursor: pointer;
}

/* shared by every variant: the decided interaction */
.cup-proto [data-synchronization-unit] { cursor: pointer; }
.cup-proto a[href] { cursor: pointer; }
.cup-proto a[data-proto-open] { background: var(--color-ink-8); border-radius: 4px; }
.cup-proto sub, .cup-proto sup { line-height: 0; }
/* wide blocks never widen the page: the shell is a grid, whose items grow to their content */
.cup-proto [data-proto-block] { contain: inline-size; }
[data-proto-backdrop] { position: fixed; inset: 0; z-index: 9000; }
[data-proto-popover] { position: fixed; z-index: 9001; font-family: var(--font-family-1); }
[data-proto-popover] a { display: flex; text-decoration: none; color: inherit; }
[data-proto-popover]::before {
  content: ""; position: absolute; left: calc(var(--arrow-x) - 6px); width: 12px; height: 12px;
  background: inherit; border: inherit; transform: rotate(45deg);
}
[data-proto-popover][data-proto-side="below"]::before { top: -7px; border-right: 0; border-bottom: 0; }
[data-proto-popover][data-proto-side="above"]::before { bottom: -7px; border-left: 0; border-top: 0; }

/* ---------- A: faithful, scroll wide ---------- */
${A} a[href] { color: var(--color-ink); text-decoration: underline 1px; text-underline-offset: 0.2em; }
${A} strong, ${A} b { font-weight: 600; color: var(--color-ink); }
${A} code, ${A} samp {
  font-family: var(--font-family-2); font-size: 0.85em; padding: 0.1em 0.3em;
  background: var(--color-ink-4); border-radius: 4px;
}
${A} kbd {
  font-family: var(--font-family-2); font-size: 0.8em; padding: 0 0.35em; background: var(--color-surface);
  border: 1px solid var(--color-ink-24); border-bottom-width: 2px; border-radius: 4px;
}
${A} var { font-style: italic; font-family: var(--font-family-1); }
${A} s, ${A} del { color: var(--color-ink-40); text-decoration-color: var(--color-ink-40); }
${A} q { quotes: "“" "”" "‘" "’"; }
${A} [data-proto-block] { overflow-x: auto; max-width: 100%; }
${A} table { border-collapse: collapse; font-size: var(--font-size-md); font-variant-numeric: tabular-nums; }
${A} caption { caption-side: top; text-align: start; color: var(--color-ink); font-weight: 500; padding-block-end: 4px; }
${A} th, ${A} td { padding: 6px 16px 6px 0; border-bottom: 1px solid var(--color-ink-8); text-align: start; white-space: nowrap; vertical-align: top; }
${A} th { font-weight: 500; color: var(--color-ink); }
${A} pre {
  font-family: var(--font-family-2); font-size: var(--font-size-sm); line-height: 1.6; white-space: pre;
  margin: 0; padding: 12px 16px; background: var(--color-ink-4); border-radius: 12px; width: max-content; min-width: 100%;
}
${A} dt { font-weight: 500; color: var(--color-ink); }
${A} dd { margin: 0 0 8px; padding-inline-start: 16px; }
/* one bubble per element of the unit */
${A} tr[aria-current="true"] { box-shadow: none; background: none; }
${A} tr[aria-current="true"] > * { background: var(--color-ink-8); color: var(--color-ink); }
${A} [data-unit-part]:not(tr)[aria-current="true"] { color: var(--color-ink); }
[data-proto-popover="A"] {
  background: var(--color-ink); color: var(--color-page); border-radius: 12px; padding: 8px 14px;
  box-shadow: 0 6px 20px rgb(0 0 0 / 25%);
}
[data-proto-popover="A"] a { flex-direction: column; gap: 2px; }
[data-proto-popover="A"] [data-proto-label] { font-weight: 500; font-size: 16px; }
[data-proto-popover="A"] [data-proto-host] { font-size: 12px; opacity: 0.6; }

/* ---------- B: reflow, nothing scrolls ---------- */
${B} a[href] {
  color: var(--color-ink); text-decoration: underline dotted 1.5px; text-underline-offset: 0.25em;
}
${B} a[href]::after { content: "↗"; font-size: 0.7em; vertical-align: 0.3em; margin-inline-start: 1px; color: var(--color-ink-40); }
${B} strong, ${B} b { font-weight: 600; }
${B} code, ${B} samp, ${B} var { font-family: var(--font-family-2); font-size: 0.9em; color: var(--color-ink); }
${B} var { font-style: italic; }
${B} kbd {
  font-family: var(--font-family-1); font-size: 0.72em; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.04em; padding: 1px 6px; border: 1px solid var(--color-ink-24); border-radius: 6px; vertical-align: 0.1em;
}
${B} s, ${B} del { text-decoration-thickness: 2px; text-decoration-color: var(--color-ink-60); }
${B} q { quotes: "“" "”" "‘" "’"; }
${B} table { width: 100%; border-collapse: collapse; font-size: var(--font-size-md); line-height: 24px; }
${B} caption { text-align: start; font-weight: 600; color: var(--color-ink); padding-block-end: 8px; }
${B} th, ${B} td { text-align: start; padding: 6px 8px 6px 0; border-top: 1px solid var(--color-ink-8); overflow-wrap: anywhere; vertical-align: top; }
${B} th { font-weight: 600; color: var(--color-ink); }
@media (max-width: 600px) {
  ${B} table, ${B} thead, ${B} tbody, ${B} tr, ${B} caption { display: block; }
  ${B} tr { border-top: 1px solid var(--color-ink-8); padding: 8px 0; }
  ${B} th, ${B} td { display: inline; border: 0; padding: 0; }
  ${B} th + th::before, ${B} td + td::before { content: " · "; color: var(--color-ink-24); font-weight: 400; }
  ${B} td:first-child { font-weight: 600; color: var(--color-ink); }
}
${B} pre {
  font-family: var(--font-family-2); font-size: var(--font-size-sm); line-height: 1.7; white-space: pre-wrap;
  overflow-wrap: anywhere; margin: 0; padding-inline-start: 12px; border-inline-start: 2px solid var(--color-ink-24);
}
${B} dt { font-weight: 600; color: var(--color-ink); }
${B} dd { margin: 0 0 8px; }
/* the highlight is a bar in the margin, one per element, so the bars line up into one */
${B} [aria-current="true"] {
  background: none; border-radius: 0; color: var(--color-ink);
  box-shadow: -10px 0 0 var(--color-page), -14px 0 0 var(--color-ink);
}
${B} [data-unit-part="first"][aria-current="true"],
${B} [data-unit-part="middle"][aria-current="true"] {
  box-shadow: -10px 0 0 var(--color-page), -14px 0 0 var(--color-ink),
    -10px var(--line-height-paragraph) 0 var(--color-page), -14px var(--line-height-paragraph) 0 var(--color-ink);
}
[data-proto-popover="B"] {
  background: var(--color-surface); color: var(--color-ink); border-radius: 16px; padding: 12px;
  border: 1px solid var(--color-ink-8); box-shadow: 0 8px 28px rgb(0 0 0 / 14%); min-width: 200px;
}
[data-proto-popover="B"] a { flex-direction: column; gap: 8px; }
[data-proto-popover="B"] [data-proto-host] { font-size: 14px; color: var(--color-ink-60); padding-inline: 4px; }
[data-proto-popover="B"] [data-proto-label] {
  font-weight: 500; font-size: 16px; text-align: center; padding: 10px 16px; border-radius: 999px;
  background: var(--color-ink); color: var(--color-page);
}

/* ---------- C: cards, mono accents ---------- */
${C} a[href] {
  color: var(--color-ink); text-decoration: none;
  background: linear-gradient(var(--color-ink-24), var(--color-ink-24)) no-repeat 0 100% / 100% 2px;
}
${C} strong, ${C} b { font-weight: 600; color: var(--color-ink); }
${C} code, ${C} samp, ${C} var, ${C} kbd { font-family: var(--font-family-2); font-size: 0.85em; color: var(--color-ink); }
${C} samp { border-bottom: 1px dashed var(--color-ink-40); }
${C} kbd { background: var(--color-ink-8); padding: 0.1em 0.4em; border-radius: 3px; }
${C} var { font-style: italic; }
${C} s, ${C} del { color: var(--color-ink-40); }
${C} q { quotes: "“" "”" "‘" "’"; font-style: italic; }
${C} [data-proto-block] {
  overflow-x: auto; max-width: 100%; background: var(--color-surface); border-radius: 16px;
  box-shadow: 0 1px 3px rgb(0 0 0 / 8%);
}
${C} table { border-collapse: separate; border-spacing: 0; font-size: var(--font-size-sm); line-height: 20px; font-variant-numeric: tabular-nums; }
${C} caption { caption-side: top; text-align: start; padding: 12px 16px 4px; font-family: var(--font-family-2); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-ink-60); }
${C} th, ${C} td { padding: 10px 16px; text-align: start; white-space: nowrap; border-bottom: 1px solid var(--color-ink-8); background: var(--color-surface); }
${C} tr:last-child > * { border-bottom: 0; }
${C} th { font-weight: 500; color: var(--color-ink-60); font-size: 12px; }
${C} tr > :first-child { position: sticky; left: 0; z-index: 1; box-shadow: 1px 0 0 var(--color-ink-8); color: var(--color-ink); }
${C} pre {
  font-family: var(--font-family-2); font-size: var(--font-size-sm); line-height: 1.7; white-space: pre;
  margin: 0; padding: 16px; width: max-content; min-width: 100%;
}
@media (min-width: 601px) {
  ${C} dl { display: grid; grid-template-columns: max-content 1fr; column-gap: 24px; row-gap: 8px; }
  ${C} dt + dt { grid-column: 1; }
  ${C} dd { grid-column: 2; margin: 0; }
}
${C} dt { font-family: var(--font-family-2); font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-ink-60); }
${C} dd { margin: 0 0 8px; }
/* one continuous block across the unit's elements: parts bridge the gap to the next one */
${C} [data-unit-part="first"][aria-current="true"],
${C} [data-unit-part="middle"][aria-current="true"] {
  border-end-start-radius: 0; border-end-end-radius: 0;
  box-shadow: 0 0 0 var(--spacing-gutter) var(--color-ink-8), 0 var(--line-height-paragraph) 0 var(--spacing-gutter) var(--color-ink-8);
}
${C} [data-unit-part="last"][aria-current="true"],
${C} [data-unit-part="middle"][aria-current="true"] { border-start-start-radius: 0; border-start-end-radius: 0; }
${C} tr[aria-current="true"] { box-shadow: none; background: none; }
${C} tr[aria-current="true"] > * { background: #ececea; color: var(--color-ink); }
[data-proto-popover="C"] {
  background: var(--color-surface); color: var(--color-ink); border: 1px solid var(--color-ink-24);
  border-radius: 8px; padding: 6px 10px; font-family: var(--font-family-2); font-size: 13px;
}
[data-proto-popover="C"] a { gap: 8px; align-items: baseline; white-space: nowrap; }
[data-proto-popover="C"] [data-proto-label] { font-weight: 700; }
[data-proto-popover="C"] [data-proto-host] { color: var(--color-ink-60); }
`;
