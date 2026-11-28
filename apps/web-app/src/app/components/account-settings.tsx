import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import React from "react";
import { Temporal } from "temporal-polyfill";

import { SignInButtons } from "#src/app/components/sign-in-dialog.js";
import { DSButton } from "#src/app/design-system/button.js";
import type { SignInMethod } from "#src/auth/account-session.js";
import {
  confirmationMismatchCopy,
  useAccountConfirmation,
} from "#src/data-fetching/account-confirmation.js";
import { accountQuery } from "#src/data-fetching/account.js";

const SIGN_IN_METHOD_ORDER: readonly SignInMethod[] = ["apple", "google", "test-account"];

export function AccountSettings({
  subject,
  email,
  purpose,
}: {
  subject: string;
  email: string | undefined;
  purpose: "settings" | "recovery";
}): React.ReactNode {
  const account = useSuspenseQuery(accountQuery(subject));
  const confirmation = useAccountConfirmation(subject);
  const { isPending: pending, error, result, begin, signIn, confirm, cancel } = confirmation;
  const data = account.data;
  if (account.error && !account.isFetching) {
    throw account.error;
  }

  const challenge =
    purpose === "recovery" && confirmation.challenge?.action === "delete"
      ? null
      : confirmation.challenge;

  const SectionHeading = purpose === "settings" ? "h3" : "h2";

  return (
    <>
      <p>{email}</p>
      {data.state === "active" ? (
        purpose === "settings" ? (
          <section aria-label="Delete account">
            <SectionHeading>Delete account</SectionHeading>
            <p>
              Access stops immediately. You can restore this account for seven days. After that,
              your account and private conversions are deleted. Original trial conversions stay
              separate.
            </p>
            <DSButton disabled={pending} onClick={() => begin("delete")}>
              Delete account…
            </DSButton>
          </section>
        ) : (
          <ActiveAccountNotice result={result} />
        )
      ) : (
        <section aria-label="Account recovery">
          <SectionHeading>Deletion scheduled</SectionHeading>
          <p>Account access is blocked. Signing in alone does not cancel deletion.</p>
          {data.recoveryDeadlineMs !== null && (
            <p>
              Recovery deadline:{" "}
              {Temporal.Instant.fromEpochMilliseconds(data.recoveryDeadlineMs).toLocaleString()}
            </p>
          )}
          <DSButton
            disabled={
              pending ||
              data.state === "deleting" ||
              (data.recoveryDeadlineMs !== null &&
                Temporal.Now.instant().epochMilliseconds >= data.recoveryDeadlineMs)
            }
            onClick={() => begin("restore")}
          >
            Restore account…
          </DSButton>
        </section>
      )}
      {challenge && (
        <ConfirmAccountChange
          action={challenge.action}
          acceptedMethods={challenge.acceptedMethods}
          signInMethod={challenge.signInMethod}
          isForThisAccount={challenge.subject === subject}
          isPending={pending}
          onSignIn={signIn}
          onConfirm={confirm}
          onCancel={cancel}
        />
      )}
      {pending && <output>Working…</output>}
      {error && <p role="alert">{error}</p>}
      {result && purpose === "settings" && <output>{result}</output>}
    </>
  );
}

function ActiveAccountNotice({ result }: { result: string | null | undefined }): React.ReactNode {
  return (
    <p>
      {result ? <output>{result}</output> : "This account is not scheduled for deletion."}{" "}
      <Link to="/recent">Go to Recent</Link>
    </p>
  );
}

function ConfirmAccountChange({
  action,
  acceptedMethods,
  signInMethod,
  isForThisAccount,
  isPending,
  onSignIn,
  onConfirm,
  onCancel,
}: {
  action: "delete" | "restore";
  acceptedMethods: readonly SignInMethod[];
  signInMethod: SignInMethod | undefined;
  isForThisAccount: boolean;
  isPending: boolean;
  onSignIn: (method: SignInMethod) => void;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactNode {
  const change = action === "delete" ? "account deletion" : "account recovery";
  return (
    <section aria-label="Confirm account change">
      {signInMethod === undefined ? (
        <>
          <p>Sign in again to confirm {change}.</p>
          <SignInButtons
            signInMethods={SIGN_IN_METHOD_ORDER.filter((method) =>
              acceptedMethods.includes(method),
            )}
            pendingMethod={undefined}
            onSignIn={onSignIn}
          />
          {action === "delete" && acceptedMethods.includes("apple") && (
            <p>
              Can&apos;t sign in with Apple? Email{" "}
              <a href="mailto:support@cup.audio">support@cup.audio</a>.
            </p>
          )}
        </>
      ) : (
        <>
          <p>
            After signing in again with the same {signInMethod === "apple" ? "Apple" : "Google"}{" "}
            account, confirm {change}.
          </p>
          <DSButton disabled={isPending || !isForThisAccount} onClick={onConfirm}>
            {action === "delete" ? "Schedule deletion" : "Confirm recovery"}
          </DSButton>
          {!isForThisAccount && (
            <p role="alert">
              {confirmationMismatchCopy({ acceptedMethods, signInMethod }, "challenge")}
            </p>
          )}
        </>
      )}
      <DSButton disabled={isPending} onClick={onCancel}>
        Cancel
      </DSButton>
    </section>
  );
}
