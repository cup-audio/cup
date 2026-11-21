import React from "react";

import { signOut } from "#src/auth/account-session.js";
import { clearPendingAccountConversion } from "#src/data-fetching/account-conversion-storage.js";

/** What the sign-in dialog says after the API refused an identity off the account allowlist. */
export const NOT_ADMITTED_MESSAGE =
  "Cup is invite-only for now, and this Google account isn't invited.";

/**
 * Whether the API refused the last signed-in identity in this page's lifetime, and whether a screen
 * that needs an account was refused, so the app has to leave it for home.
 */
type AccountRefusal = { isRefused: boolean; shouldGoHome: boolean };

const NO_REFUSAL: AccountRefusal = { isRefused: false, shouldGoHome: false };

const listeners = new Set<() => void>();
let refusal = NO_REFUSAL;

/**
 * Answers the API's `account-not-admitted`: drops a stored conversion request, which could only be
 * refused again, signs out locally, and raises the notice that the home page's sign-in dialog
 * shows. `shouldGoHome` is for a request that needed the account, whose screen cannot be shown
 * signed out. Concurrent refusals share the one sign-out.
 */
export async function refuseAccountSession({ shouldGoHome }: { shouldGoHome: boolean }) {
  clearPendingAccountConversion();
  setRefusal({ isRefused: true, shouldGoHome: refusal.shouldGoHome || shouldGoHome });
  await signOut();
}

/** Clears the notice, once the listener closes the sign-in or tries another account. */
export function dismissAccountRefusal() {
  setRefusal(NO_REFUSAL);
}

/** Marks that the app has left the refused screen for home. */
export function settleAccountRefusalAtHome() {
  if (refusal.shouldGoHome) {
    setRefusal({ ...refusal, shouldGoHome: false });
  }
}

export function useAccountRefusal(): AccountRefusal {
  return React.useSyncExternalStore(subscribe, readRefusal, readRefusal);
}

function setRefusal(next: AccountRefusal) {
  if (refusal.isRefused === next.isRefused && refusal.shouldGoHome === next.shouldGoHome) {
    return;
  }

  refusal = next;
  for (const listener of listeners) {
    listener();
  }
}

function readRefusal() {
  return refusal;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
