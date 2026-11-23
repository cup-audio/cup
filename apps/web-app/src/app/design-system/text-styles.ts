import { css } from "@linaria/core";

export const textStyles = {
  h1: css`
    font-family: var(--font-family-1);
    font-size: var(--font-size-h1);
    font-weight: var(--font-weight-inter-figma-medium);
    line-height: var(--line-height-h1);
    letter-spacing: var(--letter-spacing-tight);
  `,
  h2: css`
    font-family: var(--font-family-1);
    font-size: var(--font-size-h2);
    font-weight: var(--font-weight-inter-figma-medium);
    line-height: var(--line-height-h2);
    letter-spacing: var(--letter-spacing-tight);
  `,
  h3: css`
    font-family: var(--font-family-1);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-inter-figma-medium);
    line-height: var(--line-height-h3);
    letter-spacing: var(--letter-spacing-tight);
  `,
  h4: css`
    font-family: var(--font-family-1);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-inter-figma-medium);
    line-height: var(--line-height-h4);
  `,
  h5: css`
    font-family: var(--font-family-1);
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-inter-figma-medium);
    line-height: var(--line-height-h5);
    letter-spacing: var(--letter-spacing-tight);
  `,
  paragraph: css`
    font-family: var(--font-family-1);
    font-size: var(--font-size-lg);
    font-weight: 400;
    line-height: var(--line-height-paragraph);
  `,
  tagline: css`
    font-family: var(--font-family-1);
    font-size: var(--font-size-sm);
    font-weight: 400;
    line-height: var(--line-height-tagline);
  `,
  label: css`
    font-family: var(--font-family-1);
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-inter-figma-medium);
    line-height: var(--line-height-label);
    letter-spacing: var(--letter-spacing-tight);
  `,
  callout: css`
    font-family: var(--font-family-1);
    font-size: var(--font-size-callout);
    font-weight: var(--font-weight-inter-figma-medium);
    line-height: var(--line-height-h5);
    letter-spacing: var(--letter-spacing-tight);
  `,
} as const;

export const singleLine = css`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
