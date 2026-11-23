import { css } from "@linaria/core";
import React from "react";

import { AccountAvatar } from "#src/app/components/account-avatar.js";
import { AccountTabBar, TAB_BAR_HEIGHTS } from "#src/app/components/account-tab-bar.js";
import {
  bottomBarDuringViewTransition,
  fadeFooterClearance,
  stickyBottomBar,
} from "#src/app/components/fade-footer.js";
import { MiniPlayer } from "#src/app/components/mini-player.js";
import { textStyles } from "#src/app/design-system/text-styles.js";
import { interTypefaceScope } from "#src/app/global-styles.js";
import { composeClassnames } from "#src/app/utils.js";
import {
  BOTTOM_BAR_TRANSITION_NAME,
  RECENTS_SCREEN_TRANSITION_NAME,
} from "#src/app/view-transition-names.js";
import { useAccountSession } from "#src/auth/hooks.js";

export function RecentsLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  const session = useAccountSession();

  return (
    <>
      <div
        className={css`
          grid-area: shell-main;

          :root:active-view-transition & {
            view-transition-name: ${RECENTS_SCREEN_TRANSITION_NAME};
          }
        `}
      >
        <header
          {...interTypefaceScope}
          className={composeClassnames(
            pageWidth,
            css`
              z-index: 1;
              display: flex;
              grid-area: shell-header;
              gap: var(--spacing-gutter);
              align-items: center;
              justify-content: space-between;
              min-height: 44px;
              padding-block-start: var(--spacing-gutter);
            `,
          )}
        >
          <h1
            className={composeClassnames(
              textStyles.h1,
              css`
                padding-block-end: 8px;
                padding-inline-start: var(--spacing-gutter);
                margin: 0;
              `,
            )}
          >
            Recent
          </h1>
          {session && <AccountAvatar userMetadata={session.user.user_metadata} />}
        </header>
        <main
          {...interTypefaceScope}
          className={composeClassnames(
            pageWidth,
            css`
              display: flex;
              flex-direction: column;
              grid-area: shell-main;
              padding-block: 24px;

              padding-block-end: ${fadeFooterClearance(TAB_BAR_HEIGHTS)};
            `,
          )}
        >
          {children}
        </main>
      </div>
      <div className={stickyBottomBar}>
        <div
          className={composeClassnames(
            bottomBarDuringViewTransition,
            css`
              --bottom-bar-transition-name: ${BOTTOM_BAR_TRANSITION_NAME};

              display: grid;
            `,
          )}
        >
          <MiniPlayer />
          <AccountTabBar />
        </div>
      </div>
    </>
  );
}

const pageWidth = css`
  width: 100%;
  max-width: var(--app-max-width);
  padding-inline: var(--spacing-gutter);
  margin-inline: auto;
`;
