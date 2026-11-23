import type { SupabaseClient } from "@supabase/supabase-js";

import type { GoogleSignInOptions } from "#src/platform/account-auth.js";
import { initializeAuthStorage as initializeSecureAuthStorage } from "#src/platform/account-auth.native.js";
import { googleAuthorizationParams } from "#src/platform/account-auth.web.js";
import { AUTH_CALLBACK_URL, webAuthentication } from "#src/platform/web-authentication.js";

export { watchAppState } from "#src/platform/account-auth.native.js";

export async function initializeAuthStorage(storageKeys: readonly string[]) {
  const authStorage = await initializeSecureAuthStorage(storageKeys);
  const { KeychainAccess } = await import("@aparajita/capacitor-secure-storage");
  await authStorage.storage.setDefaultKeychainAccess(KeychainAccess.afterFirstUnlock);
  return authStorage;
}

export async function signInWithGoogle(
  client: SupabaseClient,
  _googleClientId: string | undefined,
  options: GoogleSignInOptions,
) {
  const authorization = await client.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: AUTH_CALLBACK_URL,
      skipBrowserRedirect: true,
      queryParams: googleAuthorizationParams(options),
    },
  });
  if (authorization.error) {
    throw authorization.error;
  }
  const { url } = await webAuthentication.authenticate({ url: authorization.data.url });
  const exchange = await client.auth.exchangeCodeForSession(authorizationCode(url));
  if (exchange.error) {
    throw exchange.error;
  }
}

export async function clearNativeSignIn(): Promise<void> {}

function authorizationCode(callbackUrl: string): string {
  const callback = new URL(callbackUrl);
  const code = callback.searchParams.get("code");
  if (code !== null && code !== "") {
    return code;
  }
  const fragment = new URLSearchParams(callback.hash.slice(1));
  const description =
    callback.searchParams.get("error_description") ?? fragment.get("error_description");
  throw new Error(description ?? "Sign-in did not complete.");
}
