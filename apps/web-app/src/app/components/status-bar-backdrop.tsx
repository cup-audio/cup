import { css } from "@linaria/core";
import React from "react";

export function StatusBarBackdrop(): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-status-bar-backdrop=""
      className={css`
        position: fixed;
        inset: 0 0 auto;
        /* above the routes' content, also the shell's sticky header (components/main.tsx) */
        z-index: 1;
        height: env(safe-area-inset-top, 0);
        background-color: var(--color-bg);
      `}
    />
  );
}
