import type { SupabaseClient } from "@supabase/supabase-js";

import type { GoogleSignInOptions } from "#src/platform/account-auth.js";

export async function initializeAuthStorage(storageKeys: readonly string[]) {
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
