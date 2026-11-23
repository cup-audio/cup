import type { Session } from "@supabase/supabase-js";
import { useIsMutating, useMutation } from "@tanstack/react-query";
import React from "react";

import { deletionChallengeSchema, type ProviderCredential } from "@cup/listener-api.routes";

import {
  getFreshAccountSession,
  isSignedInAs,
  signInAgain,
  signOut,
  type SignInMethod,
} from "#src/auth/account-session.js";
import {
  readPendingAccountChallenge,
  storeAccountChallenge,
  clearAccountChallenge,
  type AccountChallenge,
} from "#src/data-fetching/account-confirmation-storage.js";
import { invalidateAccountQueries, invalidateAccountSnapshot } from "#src/data-fetching/account.js";
import { ERROR_CODE, requestApi, RpcError } from "#src/data-fetching/api-request.js";
import { summarizeError, UserFacingError } from "#src/errors.js";

const ACCOUNT_CONFIRMATION_MUTATION_KEY = ["account-confirmation"];
const APPLE_REFUSALS: Partial<Record<string, string>> = {
  [ERROR_CODE.APPLE_CONFIRMATION_FAILED]:
    "Apple couldn't confirm the deletion. Your account is still active, and nothing will be deleted. Try again.",
  [ERROR_CODE.APPLE_ACCOUNT_MISMATCH]: "Use the Apple Account linked to this Cup account.",
};

type ConfirmationCommand =
  | { type: "begin"; action: "delete" | "restore" }
  | { type: "sign-in"; method: SignInMethod }
  | { type: "confirm" };

export function useAccountConfirmation(subject: string) {
  const [challenge, setChallenge] = React.useState(readPendingAccountChallenge);
  const signInWith = async (pending: AccountChallenge, method: SignInMethod) => {
    const next = { ...pending, signInMethod: method };
    storeAccountChallenge(next);
    setChallenge(next);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 1_100));
    if (!isSignedInAs(subject)) {
      throw new UserFacingError({ title: "Use the same Google account." });
    }
    await signInAgain(method);
  };
  const forgetChallenge = (challengeId: string) => {
    if (readPendingAccountChallenge()?.challengeId === challengeId) {
      clearAccountChallenge();
      setChallenge(null);
    }
  };
  const change = useMutation({
    mutationKey: ACCOUNT_CONFIRMATION_MUTATION_KEY,
    meta: { errorDisplay: "inline" },
    mutationFn: async (command: ConfirmationCommand) => {
      if (command.type === "begin") {
        const issued = deletionChallengeSchema.parse(
          await requestApi({ subject }, (client) => client.createDeletionChallenge()),
        );
        if (issued.subject !== subject || !isSignedInAs(subject)) {
          throw new UserFacingError({
            title: "Use the same Google account that requested confirmation.",
          });
        }
        const next = { ...issued, action: command.action };
        storeAccountChallenge(next);
        setChallenge(next);
        const [onlyMethod, ...otherMethods] = next.acceptedMethods;
        if (onlyMethod !== undefined && onlyMethod !== "apple" && otherMethods.length === 0) {
          await signInWith(next, onlyMethod);
        }
        return null;
      }

      const pending = readPendingAccountChallenge();
      if (!pending || pending.subject !== subject) {
        throw new UserFacingError({
          title: "Use the same Google account that requested confirmation.",
        });
      }
      if (command.type === "sign-in") {
        await signInWith(pending, command.method);
        return null;
      }

      const session = await getFreshAccountSession();
      if (session?.user.id !== subject) {
        throw new UserFacingError({ title: "Use the same Google account." });
      }
      try {
        await sendConfirmation(subject, pending, session);
      } catch (error) {
        const refusal = error instanceof RpcError ? APPLE_REFUSALS[error.code] : undefined;
        if (refusal === undefined) {
          throw error;
        }
        forgetChallenge(pending.challengeId);
        throw new UserFacingError({ title: refusal, cause: error });
      }
      if (!isSignedInAs(subject)) {
        return null;
      }
      forgetChallenge(pending.challengeId);
      await (pending.action === "delete"
        ? invalidateAccountSnapshot(subject)
        : invalidateAccountQueries(subject));
      if (!isSignedInAs(subject)) {
        return null;
      }
      if (pending.action === "delete") {
        await signOut();
        return null;
      }
      return "Your account is restored. Your existing minutes and conversions are available again.";
    },
  });
  return {
    challenge,
    isPending: change.isPending,
    error: change.error
      ? summarizeError(change.error, "The confirmation could not be completed.")
      : undefined,
    result: change.data,
    begin: (action: "delete" | "restore") => change.mutate({ type: "begin", action }),
    signIn: (method: SignInMethod) => change.mutate({ type: "sign-in", method }),
    confirm: () => change.mutate({ type: "confirm" }),
    cancel: () => {
      if (change.isPending) {
        return;
      }
      clearAccountChallenge();
      setChallenge(null);
      change.reset();
    },
  };
}

async function sendConfirmation(subject: string, pending: AccountChallenge, session: Session) {
  const providerCredential =
    pending.action === "restore" && pending.signInMethod === "apple"
      ? undefined
      : credentialOf(pending.signInMethod, session);
  const input = {
    challengeId: pending.challengeId,
    ...(providerCredential === undefined ? {} : { providerCredential }),
  };
  if (pending.action === "delete") {
    await requestApi({ subject }, (client) => client.scheduleDeletion(input));
  } else {
    await requestApi({ subject }, (client) => client.restoreAccount(input));
  }
}

function credentialOf(
  method: SignInMethod | undefined,
  session: Session,
): ProviderCredential | undefined {
  if (method === "apple") {
    return session.provider_refresh_token
      ? { provider: "apple", refreshToken: session.provider_refresh_token }
      : undefined;
  }
  return session.provider_token
    ? { provider: "google", accessToken: session.provider_token }
    : undefined;
}

export function useIsAccountConfirmationPending(): boolean {
  return useIsMutating({ mutationKey: ACCOUNT_CONFIRMATION_MUTATION_KEY }) > 0;
}
