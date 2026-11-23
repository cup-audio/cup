import { AlertDialog, Dialog, type DialogPopupProps, type DialogRootProps } from "@base-ui/react";
import { css } from "@linaria/core";
import React from "react";

import { DSButtonGroup } from "#src/app/design-system/button-group.js";
import { DSButton } from "#src/app/design-system/button.js";
import { textStyles } from "#src/app/design-system/text-styles.js";
import { interTypefaceScope } from "#src/app/global-styles.js";
import { composeClassnames } from "#src/app/utils.js";

export type DSDialogProps = {
  role?: "dialog" | "alertdialog";
  open: DialogRootProps["open"];
  onOpenChange: DialogRootProps["onOpenChange"];
  initialFocus: DialogPopupProps["initialFocus"];
  finalFocus: DialogPopupProps["finalFocus"];
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  cancelButtonText: React.ReactNode;
  cancelButtonDisabled: boolean;
  cancelButtonRef?: React.Ref<HTMLButtonElement>;
  buttonGroupChildren?: React.ReactNode;
  errorMessage?: React.ReactNode;
};

export const DSDialog: React.FC<DSDialogProps> = ({
  role = "dialog",
  open,
  onOpenChange,
  initialFocus,
  finalFocus,
  title,
  description,
  children,
  cancelButtonText,
  cancelButtonDisabled,
  cancelButtonRef,
  buttonGroupChildren,
  errorMessage,
}) => {
  const Root = role === "alertdialog" ? AlertDialog.Root : Dialog.Root;

  return (
    <Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal
        className={css`
          isolation: isolate;
        `}
      >
        <Dialog.Backdrop
          className={css`
            position: fixed;
            inset: 0;
            background: var(--background-dialog-backdrop);
          `}
        />
        <Dialog.Popup
          {...interTypefaceScope}
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          className={css`
            position: fixed;
            top: 50%;
            left: 50%;

            display: grid;
            gap: calc(2 * var(--spacing-base));
            min-width: min(400px, calc(100vw - 2 * var(--spacing-gutter)));
            padding: var(--spacing-gutter);

            overflow: auto;
            background: var(--color-surface);
            border: 1px solid var(--color-ink-4);
            border-radius: var(--border-radius-lg);
            box-shadow: var(--shadow-card);
            transform: translate(-50%, -50%);
          `}
        >
          <div>
            <Dialog.Title className={textStyles.h2}>{title}</Dialog.Title>
            {description && (
              <Dialog.Description
                className={composeClassnames(
                  textStyles.paragraph,
                  css`
                    padding-block-start: var(--spacing-base);
                  `,
                )}
              >
                {description}
              </Dialog.Description>
            )}
          </div>
          {children}

          <DSButtonGroup
            className={css`
              padding-block-start: var(--spacing-base);
            `}
          >
            <Dialog.Close
              ref={cancelButtonRef}
              render={<DSButton variant="text" disabled={cancelButtonDisabled} />}
            >
              {cancelButtonText}
            </Dialog.Close>
            {buttonGroupChildren}
          </DSButtonGroup>

          {errorMessage && <p role="alert">{errorMessage}</p>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Root>
  );
};
