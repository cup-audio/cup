import {
  BOTTOM_BAR_TRANSITION_NAME,
  TRACK_COVER_TRANSITION_NAME,
} from "#src/app/view-transition-names.js";

export const cssReset = css`
  @layer reset {
    /* based on https://www.joshwcomeau.com/css/custom-css-reset/ */

    /* 1. Use a more-intuitive box-sizing model */
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    /* 2. Remove default margin */
    *:not(dialog) {
      margin: 0;
    }

    /* 3. Enable keyword animations */
    @media (prefers-reduced-motion: no-preference) {
      html {
        interpolate-size: allow-keywords;
      }
    }

    body {
      /* 4. Increase line-height */
      line-height: 1.5;
      /* 5. Improve text rendering */
      -webkit-font-smoothing: antialiased;
    }

    /* 6. Improve media defaults */
    img,
    picture,
    video,
    canvas,
    svg {
      display: block;
      max-width: 100%;
    }

    /* 7. Inherit fonts for form controls */
    input,
    button,
    textarea,
    select {
      font: inherit;
    }

    /* 8. Avoid text overflows */
    p,
    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      overflow-wrap: break-word;
    }

    /* 9. Improve line wrapping */
    p {
      text-wrap: pretty;
    }

    /*
      10. Create a root stacking context
      (also for https://base-ui.com/react/overview/quick-start#portals)
    */
    #root,
    #__next {
      isolation: isolate;
    }
  }
`;

export const interTypefaceScope = { "data-typeface": "inter" } as const;

export const cssBase = css`
  @layer base {
    :root {
      /* https://base-ui.com/react/overview/quick-start#ios-26-safari */
      position: relative;

      font-family: var(--font-family-1);
      font-size: ${16 / 16}rem;
      color: var(--color-fg);
      scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
      background-color: var(--color-bg);
      --font-family-1: "Inter Variable", sans-serif;
      --font-family-2: "Space Mono", monospace;

      --color-ink-rgb: 18 18 18;
      --color-ink: rgb(var(--color-ink-rgb));
      --color-ink-60: rgb(var(--color-ink-rgb) / 60%);
      --color-ink-40: rgb(var(--color-ink-rgb) / 40%);
      --color-ink-24: rgb(var(--color-ink-rgb) / 24%);
      --color-ink-8: rgb(var(--color-ink-rgb) / 8%);
      --color-ink-4: rgb(var(--color-ink-rgb) / 4%);
      --color-page: #f6f6f3;
      --color-surface: #fff;
      --color-placeholder: #ececec;
      --color-error: #b42318;
      --color-fg: var(--color-ink);
      --color-bg: var(--color-page);
      --color-primary: var(--color-ink);
      --color-fg-emphasized-sm: var(--color-ink-60);
      --color-fg-emphasized-xs: var(--color-ink-40);

      --font-size-xs: 12px;
      --font-size-sm: 14px;
      --font-size-md: 16px;
      --font-size-lg: 18px;
      --font-size-xl: 22px;
      --font-size-xxl: 26px;
      --font-size-xxxl: 30px;
      --font-size-display: 36px;
      --font-size-h1: 32px;
      --font-size-h2: 24px;
      --font-size-callout: 20px;
      --font-weight-inter-figma-medium: 500;
      --line-height-h1: 32px;
      --line-height-h2: 26px;
      --line-height-h3: 20px;
      --line-height-h4: 22px;
      --line-height-h5: 24px;
      --line-height-paragraph: 32px;
      --line-height-tagline: 14px;
      --line-height-label: 12px;
      --line-height-display: 55px;
      --letter-spacing-tight: -0.02em;

      --spacing-base: 8px;
      --spacing-gutter: 12px;
      --app-padding-block: calc(1.5 * var(--spacing-base));
      --app-padding-inline: calc(2 * var(--spacing-base));
      --app-max-width: 800px;

      --border-radius-sm: 4px;
      --border-radius-lg: 24px;
      --border-radius-full: 9999px;

      --shadow-card: 4px -4px 20px rgb(0 0 0 / 12%);
      --background-fade-tab-bar: linear-gradient(to bottom, transparent, var(--color-surface));
      --background-fade-player-sheet: linear-gradient(to bottom, transparent, var(--color-surface));

      --background-dialog-backdrop: rgb(var(--color-ink-rgb) / 40%);

      --focus-ring: 2px solid var(--color-ink);
      --focus-ring-offset: 2px;

      --scrollbar-thumb: var(--color-fg);
      --scrollbar-track: transparent;
    }

    * {
      scrollbar-width: thin;
    }

    :focus-visible {
      outline: var(--focus-ring);
      outline-offset: var(--focus-ring-offset);
    }

    :root {
      view-transition-name: none;
    }

    ::view-transition-group(${TRACK_COVER_TRANSITION_NAME}) {
      z-index: 1;
      animation-duration: 300ms;
      animation-timing-function: cubic-bezier(0.2, 0, 0, 1);
    }

    ::view-transition-group(${BOTTOM_BAR_TRANSITION_NAME}) {
      z-index: 2;
    }

    ::view-transition-old(${BOTTOM_BAR_TRANSITION_NAME}),
    ::view-transition-new(${BOTTOM_BAR_TRANSITION_NAME}) {
      top: auto;
      bottom: 0;
    }

    ::selection {
      color: var(--color-bg);
      background: var(--color-fg);
    }

    a {
      color: inherit;
      text-underline-offset: 0.2em;
    }

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      font-family: var(--font-family-1);
    }
    :where(span, input):not(:where([data-typeface="inter"], [data-typeface="inter"] *)) {
      font-family: var(--font-family-2);
    }
  }
`;

function css(strings: TemplateStringsArray, ...args: Array<string | number>): string {
  let result = strings[0] ?? "";
  for (const [index, argument] of args.entries()) {
    result += `${argument}${strings[index + 1]}`;
  }
  return result;
}
