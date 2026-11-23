import type { SupabaseClient } from "@supabase/supabase-js";

import type { GoogleSignInOptions } from "#src/platform/account-auth.js";
import { reportFailure } from "#src/report-failure.js";

const APPLE_SIGN_IN_MARKER_STORAGE_KEY = "cup_apple_sign_in_pending";

let completedAppleSignIn = false;

export async function initializeAuthStorage(
  storageKeys: readonly string[],
  report: typeof reportFailure = reportFailure,
) {
  readAppleSignInReturn(report);
  const storage = window.localStorage;
  return {
    storage,
    detectSessionInUrl: true,
    clearStoredSession: async () => {
      for (const key of storageKeys) {
        storage.removeItem(key);
      }
    },
  };
}
export async function signInWithGoogle(
  client: SupabaseClient,
  _googleClientId: string | undefined,
  options: GoogleSignInOptions,
) {
  const result = await client.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}${window.location.pathname}`,
      queryParams: googleAuthorizationParams(options),
    },
  });
  if (result.error) {
    throw result.error;
  }
}

export async function signInWithApple(client: Pick<SupabaseClient, "auth">) {
  window.sessionStorage.setItem(APPLE_SIGN_IN_MARKER_STORAGE_KEY, "true");
  const result = await client.auth.signInWithOAuth({
    provider: "apple",
    options: {
      redirectTo: `${window.location.origin}${window.location.pathname}`,
      scopes: "email",
    },
  });
  if (result.error) {
    window.sessionStorage.removeItem(APPLE_SIGN_IN_MARKER_STORAGE_KEY);
    throw result.error;
  }
}

export function takeCompletedAppleSignIn(): boolean {
  const completed = completedAppleSignIn;
  completedAppleSignIn = false;
  return completed;
}

function readAppleSignInReturn(report: typeof reportFailure) {
  if (window.sessionStorage.getItem(APPLE_SIGN_IN_MARKER_STORAGE_KEY) === null) {
    return;
  }
  window.sessionStorage.removeItem(APPLE_SIGN_IN_MARKER_STORAGE_KEY);
  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const error = query.get("error") ?? fragment.get("error");
  if (error === null) {
    completedAppleSignIn = query.has("code");
    return;
  }
  const errorCode = query.get("error_code") ?? fragment.get("error_code");
  const description = query.get("error_description") ?? fragment.get("error_description");
  report("Apple sign-in on the web failed")(
    new Error(`${error}${errorCode === null ? "" : ` (${errorCode})`}: ${description ?? ""}`),
  );
}

export function googleAuthorizationParams({
  fresh,
  chooseAccount,
}: GoogleSignInOptions): Record<string, string> {
  if (fresh) {
    return { prompt: "select_account", max_age: "0" };
  }
  if (chooseAccount) {
    return { prompt: "select_account" };
  }
  return {};
}

export function watchAppState(_listener: (isActive: boolean) => void): () => void {
  return () => {};
}

export async function clearNativeSignIn(): Promise<void> {}
