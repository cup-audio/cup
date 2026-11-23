import { css } from "@linaria/core";

type FadeFooterHeights = {
  fadeHeightPixels: number;
};

export function fadeFooterClearance({ fadeHeightPixels }: FadeFooterHeights): string {
  return `${fadeHeightPixels}px`;
}

export const FADE_FOOTER_CONTROLS_END_DISTANCE_PIXELS = 24;

export const stickyBottomBar = css`
  position: sticky;
  bottom: 0;

  z-index: 1;
  grid-area: shell-footer;
`;

export const bottomBarDuringViewTransition = css`
  :root:active-view-transition & {
    view-transition-name: var(--bottom-bar-transition-name);
  }
`;

export const fadeFooter = css`
  position: relative;

  &::before {
    position: absolute;
    inset-inline: 0;
    bottom: 100%;
    z-index: -1;
    height: var(--fade-height);

    pointer-events: none;
    content: "";
    background: var(--fade-background);
  }
`;
