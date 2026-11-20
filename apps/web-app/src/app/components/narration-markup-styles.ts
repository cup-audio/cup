import { css } from "@linaria/core";

/**
 * The look of the markup a narration document keeps around its units, and of a segment's highlight
 * inside a table or preformatted text, as docs/architecture/web-app.md#reader describes it. It goes
 * on the element the narration document is rendered into, which sets the body text style and the
 * highlight bubble.
 */
export const narrationMarkupClassName = css`
  a[href] {
    color: var(--color-ink);
    text-decoration: underline dotted 1.5px;
    text-underline-offset: 0.25em;
  }

  /*
    decorative: the underline marks the link, so the marker stays out of the link's name; ink-60, as
    the marker tells the listener the link leaves Cup and needs 3:1 contrast, which ink-40 misses
  */
  a[href]::after {
    margin-inline-start: 1px;
    font-size: 0.7em;
    vertical-align: 0.3em;
    color: var(--color-ink-60);
    content: "↗" / "";
  }

  strong,
  b {
    font-weight: 600;
    color: var(--color-ink);
  }

  code,
  samp {
    padding: 0.1em 0.3em;
    font-family: var(--font-family-2);
    font-size: 0.85em;
    background-color: var(--color-ink-4);
    border-radius: var(--border-radius-sm);
  }

  kbd {
    padding: 0 0.35em;
    font-family: var(--font-family-2);
    font-size: 0.8em;
    background-color: var(--color-surface);
    border: 1px solid var(--color-ink-24);
    border-bottom-width: 2px;
    border-radius: var(--border-radius-sm);
  }

  var {
    font-family: var(--font-family-1);
    font-style: italic;
  }

  s,
  del {
    color: var(--color-ink-40);
    text-decoration-color: var(--color-ink-40);
  }

  q {
    quotes: "“" "”" "‘" "’";
  }

  /* raised and lowered text keeps the paragraph's line spacing */
  sub,
  sup {
    line-height: 0;
  }

  dt {
    font-weight: var(--font-weight-inter-figma-medium);
    color: var(--color-ink);
  }

  dd {
    padding-inline-start: calc(2 * var(--spacing-base));
    margin: 0;
  }

  dd + dt {
    margin-block-start: var(--spacing-base);
  }

  /* the server's wrapper of every table and pre (wrapInScrollCard in @cup/narration-document-creation) */
  [data-scroll-card] {
    /*
      The card's content never sizes it, so a wide block scrolls inside the card instead of widening
      the shell's grid column and with it the page.
    */
    contain: inline-size;
    overflow-x: auto;
    background-color: var(--color-surface);
    border-radius: calc(2 * var(--spacing-base));
    box-shadow: 0 1px 3px rgb(var(--color-ink-rgb) / 8%);
  }

  table {
    font-size: var(--font-size-sm);
    font-variant-numeric: tabular-nums;
    line-height: 20px;
    border-spacing: 0;
    border-collapse: separate;
  }

  caption {
    padding: var(--spacing-gutter) calc(2 * var(--spacing-base)) 4px;
    font-family: var(--font-family-2);
    font-size: var(--font-size-xs);
    color: var(--color-ink-60);
    text-align: start;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    caption-side: top;
  }

  th,
  td {
    padding: 10px calc(2 * var(--spacing-base));
    vertical-align: top;
    text-align: start;
    white-space: nowrap;

    /* opaque, so the fixed first column covers the cells that scroll under it */
    background-color: var(--color-surface);
    border-bottom: 1px solid var(--color-ink-8);
  }

  tr:last-child > :is(th, td) {
    border-bottom: 0;
  }

  th {
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-inter-figma-medium);
    color: var(--color-ink-60);
  }

  /* the first cell, not a row's Play from here button (narration-document-interaction.ts) */
  tr > :nth-child(1 of th, td) {
    position: sticky;
    inset-inline-start: 0;
    z-index: 1;
    box-shadow: 1px 0 0 var(--color-ink-8);
  }

  pre {
    box-sizing: border-box;
    width: max-content;
    min-width: 100%;
    padding: calc(2 * var(--spacing-base));
    margin: 0;
    font-family: var(--font-family-2);
    font-size: var(--font-size-sm);
    line-height: 1.7;
    white-space: pre;
  }

  /*
    Inside a card the bubble would be cut off by the card's edge and cover the neighbouring cells,
    so a highlighted caption, cell or pre is tinted within its own box. The cells stay opaque for
    the fixed first column.
  */
  [data-scroll-card] [aria-current="true"] {
    border-radius: 0;
    box-shadow: none;
  }

  [data-scroll-card] tr[aria-current="true"] {
    background-color: transparent;
  }

  tr[aria-current="true"] > :is(th, td),
  :is(th, td)[aria-current="true"] {
    color: var(--color-ink);
    background-color: var(--color-surface);
    background-image: linear-gradient(var(--color-ink-8), var(--color-ink-8));
  }

  tr[aria-current="true"] > :nth-child(1 of th, td),
  tr > :nth-child(1 of th, td)[aria-current="true"] {
    box-shadow: 1px 0 0 var(--color-ink-8);
  }

  /* a row draws no border, so its first cell carries the failed-segment mark */
  tr[data-synthesis-failed] {
    padding-inline-start: 0;
    border-inline-start: 0;
  }

  tr[data-synthesis-failed] > :nth-child(1 of th, td) {
    box-shadow:
      inset 3px 0 0 var(--color-error),
      1px 0 0 var(--color-ink-8);
  }
`;
