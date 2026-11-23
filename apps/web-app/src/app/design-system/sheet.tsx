import { Drawer } from "@base-ui/react";
import { css } from "@linaria/core";
import React from "react";

import { DSIconButton } from "#src/app/design-system/icon-button.js";
import { CloseIcon } from "#src/app/design-system/icons.js";
import { textStyles } from "#src/app/design-system/text-styles.js";
import { interTypefaceScope } from "#src/app/global-styles.js";

export type DSSheetProps = {
  open: Drawer.Root.Props["open"];
  onOpenChange: Drawer.Root.Props["onOpenChange"];
  onClosed: () => void;
  finalFocus: Drawer.Popup.Props["finalFocus"];
  title: React.ReactNode;
  children: React.ReactNode;
  closeButtonDisabled: boolean;
};

const SLIDE_DURATION = "450ms";
const SLIDE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
const CLOSE_DURATION = `calc(var(--drawer-swipe-strength) * ${SLIDE_DURATION})`;
const OFFSCREEN_TRANSFORM = "translateY(calc(100% + 24px))";

export const DSSheet: React.FC<DSSheetProps> = ({
  open,
  onOpenChange,
  onClosed,
  finalFocus,
  title,
  children,
  closeButtonDisabled,
}) => {
  const popupRef = React.useRef<HTMLDivElement>(null);

  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) {
          onClosed();
        }
      }}
    >
      <Drawer.Portal
        className={css`
          isolation: isolate;
        `}
      >
        <Drawer.Backdrop
          className={css`
            position: fixed;
            inset: 0;
            background: var(--background-dialog-backdrop);
            opacity: calc(1 - var(--drawer-swipe-progress));

            @media (prefers-reduced-motion: no-preference) {
              transition: opacity ${SLIDE_DURATION} ${SLIDE_EASING};
              animation: sheet-backdrop-fade-in ${SLIDE_DURATION} ${SLIDE_EASING} both;

              &[data-swiping] {
                transition-duration: 0ms;
              }

              &[data-ending-style],
              &[data-closed] {
                animation: sheet-backdrop-fade-out ${CLOSE_DURATION} ${SLIDE_EASING} forwards;
              }
            }

            @keyframes sheet-backdrop-fade-in {
              from {
                opacity: 0;
              }
            }

            @keyframes sheet-backdrop-fade-out {
              to {
                opacity: 0;
              }
            }
          `}
        />
        <Drawer.Viewport
          className={css`
            position: fixed;
            inset: 0;
            display: flex;
            align-items: flex-end;
            justify-content: center;
          `}
        >
          <Drawer.Popup
            {...interTypefaceScope}
            ref={popupRef}
            initialFocus={popupRef}
            finalFocus={finalFocus}
            className={css`
              position: relative;

              width: calc(min(100%, var(--app-max-width)) - 2 * var(--spacing-gutter));
              min-height: min(313px, calc(100dvh - 2 * var(--spacing-gutter)));
              max-height: calc(100dvh - 2 * var(--spacing-gutter));
              padding-block: calc(1.5 * var(--spacing-base))
                calc(var(--spacing-gutter) + env(safe-area-inset-bottom, 0px));
              padding-inline: var(--spacing-gutter);

              overflow: auto;
              overscroll-behavior: contain;
              outline: none;
              background: var(--color-surface);
              border-start-start-radius: var(--border-radius-lg);
              border-start-end-radius: var(--border-radius-lg);
              box-shadow: var(--shadow-card);
              transform: translateY(var(--drawer-swipe-movement-y));

              &[data-swiping] {
                user-select: none;
              }

              @media (prefers-reduced-motion: no-preference) {
                transition: transform ${SLIDE_DURATION} ${SLIDE_EASING};
                animation: sheet-slide-in ${SLIDE_DURATION} ${SLIDE_EASING} both;

                &[data-ending-style],
                &[data-closed] {
                  animation: sheet-slide-out ${CLOSE_DURATION} ${SLIDE_EASING} forwards;
                }
              }

              @keyframes sheet-slide-in {
                from {
                  transform: ${OFFSCREEN_TRANSFORM};
                }
              }

              @keyframes sheet-slide-out {
                to {
                  transform: ${OFFSCREEN_TRANSFORM};
                }
              }
            `}
          >
            <div
              aria-hidden="true"
              className={css`
                position: absolute;
                top: 4px;
                left: 50%;
                width: 41px;
                height: 4px;
                background: var(--color-ink-40);
                border-radius: var(--border-radius-full);
                transform: translateX(-50%);
              `}
            />
            <div
              className={css`
                display: flex;
                gap: var(--spacing-gutter);
                align-items: center;
                justify-content: space-between;
                min-height: 32px;
              `}
            >
              <Drawer.Title className={textStyles.h2}>{title}</Drawer.Title>
              <Drawer.Close
                disabled={closeButtonDisabled}
                render={
                  <DSIconButton
                    label="Close"
                    icon={<CloseIcon />}
                    className={css`
                      margin: -6px;
                      color: var(--color-ink-40);
                    `}
                  />
                }
              />
            </div>
            <Drawer.Content>{children}</Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
};
