import { Menu } from "@base-ui/react/menu";
import { css } from "@linaria/core";
import { Link, useRouter } from "@tanstack/react-router";
import React from "react";

import { iconButtonStyles } from "#src/app/design-system/icon-button.js";
import { BackChevronIcon, MoreIcon } from "#src/app/design-system/icons.js";
import { pressableOverlay } from "#src/app/design-system/interaction-states.js";
import { singleLine, textStyles } from "#src/app/design-system/text-styles.js";
import { interTypefaceScope } from "#src/app/global-styles.js";
import { composeClassnames } from "#src/app/utils.js";

export type DetailBack = { to: "/recent" | "/"; shouldGoBackInHistory: boolean };

type DetailTopBarProps = {
  back: DetailBack;
  compactTitle: { title: string; host: string; isShown: boolean } | undefined;
  menu: DetailMenuProps | undefined;
};

type DetailMenuProps = {
  originalUrl: string;
  retry: { isPending: boolean; start: () => void } | undefined;
  deletion: { start: () => void } | undefined;
};

export function DetailTopBar({ back, compactTitle, menu }: DetailTopBarProps): React.JSX.Element {
  const router = useRouter();

  return (
    <div
      {...interTypefaceScope}
      className={css`
        display: grid;
        grid-template-areas: "back title menu";
        grid-template-columns: max-content minmax(0, 1fr) max-content;
        gap: var(--spacing-base);
        align-items: center;
        width: 100%;
        min-height: 40px;
      `}
    >
      <Link
        to={back.to}
        onClick={(event) => {
          if (back.shouldGoBackInHistory) {
            event.preventDefault();
            router.history.back();
          }
        }}
        aria-label="Back"
        className={composeClassnames(
          iconButtonStyles,
          css`
            grid-area: back;
          `,
        )}
      >
        <BackChevronIcon />
      </Link>

      {compactTitle ? (
        <div
          data-shown={compactTitle.isShown}
          className={css`
            display: grid;
            grid-area: title;
            gap: 4px;
            justify-items: center;
            text-align: center;

            /* hidden also leaves the accessibility tree, once the fade-out has finished */
            &[data-shown="false"] {
              visibility: hidden;
              opacity: 0;
            }

            @media (prefers-reduced-motion: no-preference) {
              transition:
                opacity 200ms ease,
                visibility 0s;

              &[data-shown="false"] {
                transition:
                  opacity 200ms ease,
                  visibility 0s 200ms;
              }
            }

            & > p {
              max-width: 100%;
            }
          `}
        >
          <p
            className={composeClassnames(
              textStyles.tagline,
              singleLine,
              css`
                font-weight: var(--font-weight-inter-figma-medium);
              `,
            )}
          >
            {compactTitle.title}
          </p>
          <p
            className={composeClassnames(
              textStyles.tagline,
              singleLine,
              css`
                color: var(--color-ink-40);
              `,
            )}
          >
            {compactTitle.host}
          </p>
        </div>
      ) : null}

      {menu ? <DetailMenu {...menu} /> : null}
    </div>
  );
}

function DetailMenu({ originalUrl, retry, deletion }: DetailMenuProps) {
  const isDeletionRequested = React.useRef(false);

  return (
    <Menu.Root
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen && isDeletionRequested.current) {
          isDeletionRequested.current = false;
          deletion?.start();
        }
      }}
    >
      <Menu.Trigger
        aria-label="More"
        className={composeClassnames(
          iconButtonStyles,
          css`
            grid-area: menu;
          `,
        )}
      >
        <MoreIcon />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup
            {...interTypefaceScope}
            className={css`
              display: grid;
              min-width: 200px;
              padding: var(--spacing-base);
              outline: 0;

              background-color: var(--color-surface);
              border-radius: var(--border-radius-lg);
              box-shadow: var(--shadow-card);
            `}
          >
            <Menu.LinkItem
              href={originalUrl}
              target="_blank"
              rel="noopener noreferrer"
              closeOnClick
              className={menuItemStyles}
            >
              Open original page
            </Menu.LinkItem>
            {retry ? (
              <Menu.Item
                disabled={retry.isPending}
                onClick={retry.start}
                className={menuItemStyles}
              >
                Retry
              </Menu.Item>
            ) : null}
            {deletion ? (
              <Menu.Item
                onClick={() => {
                  isDeletionRequested.current = true;
                }}
                className={destructiveMenuItemStyles}
              >
                Delete track
              </Menu.Item>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const menuItemStyles = composeClassnames(
  textStyles.h5,
  pressableOverlay,
  css`
    display: block;
    padding-block: var(--spacing-base);
    padding-inline: var(--spacing-gutter);

    color: var(--color-ink);
    text-decoration: none;
    cursor: pointer;
    user-select: none;
    border-radius: calc(var(--border-radius-lg) - var(--spacing-base));

    /* Base UI highlights the item under the pointer or keyboard focus */
    &[data-highlighted] {
      background-color: var(--color-ink-8);
    }

    &[data-disabled] {
      color: var(--color-ink-24);
      cursor: not-allowed;
    }
  `,
);

const destructiveMenuItemStyles = composeClassnames(
  menuItemStyles,
  css`
    color: var(--color-error);
  `,
);
