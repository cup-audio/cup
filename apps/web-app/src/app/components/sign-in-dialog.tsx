import { css } from "@linaria/core";
import React from "react";

import { AppleLogo, GoogleLogo } from "#src/app/components/sign-in-logos.js";
import { DSButton } from "#src/app/design-system/button.js";
import { DSDialog, type DSDialogProps } from "#src/app/design-system/dialog.js";
import type { SignInMethod } from "#src/auth/account-session.js";

type SignInDialogProps = Pick<
  DSDialogProps,
  "open" | "onOpenChange" | "finalFocus" | "description" | "errorMessage"
> & {
  signInMethods: readonly SignInMethod[];
  pendingMethod: SignInMethod | undefined;
  onSignIn: (method: SignInMethod) => void;
};

const SIGN_IN_LABELS: Record<SignInMethod, string> = {
  apple: "Continue with Apple",
  google: "Continue with Google",
  "test-account": "Sign in with test account",
};

const SIGN_IN_LOGOS: Partial<Record<SignInMethod, React.ReactNode>> = {
  apple: <AppleLogo />,
  google: <GoogleLogo />,
};

const signInButtonList = css`
  display: grid;
  flex-basis: 100%;
  gap: var(--spacing-base);
`;

const providerButton = css`
  background-color: var(--color-surface);
`;

export function SignInDialog({
  open,
  onOpenChange,
  finalFocus,
  description,
  errorMessage,
  signInMethods,
  pendingMethod,
  onSignIn,
}: SignInDialogProps): React.ReactNode {
  const signInButton = React.useRef<HTMLButtonElement>(null);

  return (
    <DSDialog
      open={open}
      onOpenChange={onOpenChange}
      initialFocus={signInButton}
      finalFocus={finalFocus}
      title={<>Sign in</>}
      description={description}
      cancelButtonText={<>Cancel</>}
      cancelButtonDisabled={pendingMethod !== undefined}
      buttonGroupChildren={
        <SignInButtons
          signInMethods={signInMethods}
          pendingMethod={pendingMethod}
          onSignIn={onSignIn}
          refs={{ firstButton: signInButton }}
        />
      }
      errorMessage={errorMessage}
    />
  );
}

export function SignInButtons({
  signInMethods,
  pendingMethod,
  onSignIn,
  refs,
}: Pick<SignInDialogProps, "signInMethods" | "pendingMethod" | "onSignIn"> & {
  refs?: { firstButton?: React.Ref<HTMLButtonElement> | undefined };
}): React.JSX.Element {
  return (
    <div className={signInButtonList}>
      {signInMethods.map((method, index) => {
        const logo = SIGN_IN_LOGOS[method];
        return (
          <DSButton
            key={method}
            ref={index === 0 ? refs?.firstButton : undefined}
            variant={logo === undefined ? "contained" : "outlined"}
            className={logo === undefined ? undefined : providerButton}
            disabled={pendingMethod !== undefined}
            onClick={() => onSignIn(method)}
          >
            {logo}
            {pendingMethod === method ? "Signing in…" : SIGN_IN_LABELS[method]}
          </DSButton>
        );
      })}
    </div>
  );
}
