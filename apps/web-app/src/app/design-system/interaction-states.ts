import { css } from "@linaria/core";

export const pressableOverlay = css`
  /* containing block for the overlay below */
  position: relative;

  &::after {
    position: absolute;
    inset: 0;

    pointer-events: none;
    content: "";
    background-color: var(--color-ink-8);
    border-radius: inherit;
    opacity: 0;
  }

  &:active:not(:disabled, [aria-disabled="true"])::after {
    opacity: 1;
  }

  @media (hover: hover) {
    &:hover:not(:disabled, [aria-disabled="true"])::after {
      opacity: 1;
    }
  }
`;
