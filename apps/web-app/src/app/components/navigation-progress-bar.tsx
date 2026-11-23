import { css } from "@linaria/core";
import { useRouterState } from "@tanstack/react-router";
import React from "react";

import { useHasViewTransitionStarted } from "#src/app/cover-transition.js";

const SHOW_DELAY_MS = 100;

export function NavigationProgressBar(): React.ReactNode {
  const isNavigationPending = useRouterState({
    select: (state) => state.status === "pending" && state.resolvedLocation !== undefined,
  });
  const pendingLocation = useRouterState({ select: (state) => state.location });
  const isWaitingOnViewTransition = useHasViewTransitionStarted(pendingLocation);

  return isNavigationPending && !isWaitingOnViewTransition ? <DelayedProgressBar /> : null;
}

function DelayedProgressBar(): React.ReactNode {
  const [isShown, setIsShown] = React.useState(false);

  React.useEffect(() => {
    const timer = setTimeout(() => setIsShown(true), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!isShown) {
    return null;
  }

  return (
    <progress
      aria-label="Loading"
      data-pending-signal=""
      className={css`
        position: fixed;
        /* below the status bar, which the page reaches under (viewport-fit=cover in index.html) */
        inset: env(safe-area-inset-top, 0) 0 auto;
        z-index: 1000;
        display: block;
        width: 100%;
        height: 3px;
        appearance: none;
        pointer-events: none;
        background-color: var(--color-ink-24);
        background-image: linear-gradient(var(--color-ink), var(--color-ink));
        background-repeat: no-repeat;
        background-size: 40% 100%;
        border: 0;
        animation: navigation-progress-slide 1s ease-in-out infinite;

        /* an indeterminate bar draws no value, so only the element's own background shows */
        &::-webkit-progress-bar {
          background: transparent;
        }

        &::-moz-progress-bar {
          background: transparent;
        }

        @keyframes navigation-progress-slide {
          from {
            background-position: -70% 0;
          }
          to {
            background-position: 170% 0;
          }
        }

        @keyframes navigation-progress-pulse {
          from {
            opacity: 0.3;
          }
          to {
            opacity: 1;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          background-size: 100% 100%;
          animation: navigation-progress-pulse 1.5s ease-in-out infinite alternate;
        }
      `}
    />
  );
}
