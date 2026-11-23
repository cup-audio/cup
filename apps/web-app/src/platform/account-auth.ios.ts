import { registerPlugin } from "@capacitor/core";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AppleProviderCredential } from "@cup/listener-api.routes";

import { SignInCancelledError, UserFacingError } from "#src/errors.js";
import type { GoogleSignInOptions } from "#src/platform/account-auth.js";
import {
  createNonce,
  initializeAuthStorage as initializeSecureAuthStorage,
} from "#src/platform/account-auth.native.js";
import { googleAuthorizationParams } from "#src/platform/account-auth.web.js";

export { watchAppState } from "#src/platform/account-auth.native.js";

export async function initializeAuthStorage(storageKeys: readonly string[]) {
  const authStorage = await initializeSecureAuthStorage(storageKeys);
  const { KeychainAccess } = await import("@aparajita/capacitor-secure-storage");
  await authStorage.storage.setDefaultKeychainAccess(KeychainAccess.afterFirstUnlock);
  return authStorage;
}

const IOS_AUTH_CALLBACK_URL = "audio.cup.app://auth/callback";

type WebAuthenticationPlugin = {
  authenticate(options: { url: string }): Promise<{ url: string }>;
};

const webAuthentication = registerPlugin<WebAuthenticationPlugin>("WebAuthentication");

export async function signInWithGoogle(
  client: SupabaseClient,
  _googleClientId: string | undefined,
  options: GoogleSignInOptions,
) {
  const authorization = await client.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: IOS_AUTH_CALLBACK_URL,
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

type AppleSignInPlugin = {
  signIn(options: { nonce: string }): Promise<{ identityToken: string; authorizationCode: string }>;
};

const appleSignIn = registerPlugin<AppleSignInPlugin>("AppleSignIn");

let latestAppleCredential: AppleProviderCredential | undefined;
let completedAppleSignIn = false;

export async function signInWithApple(client: {
  auth: Pick<SupabaseClient["auth"], "signInWithIdToken">;
}) {
  const { nonce, hashedNonce } = await createNonce();
  let sheet;
  try {
    sheet = await appleSignIn.signIn({ nonce: hashedNonce });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "CANCELED") {
      throw new SignInCancelledError({ provider: "Apple", cause: error });
    }
    throw new UserFacingError({
      title: "Apple sign-in could not be completed. Try again.",
      cause: error,
    });
  }
  const credential = { provider: "apple" as const, authorizationCode: sheet.authorizationCode };
  latestAppleCredential = credential;
  completedAppleSignIn = true;
  const exchange = await client.auth.signInWithIdToken({
    provider: "apple",
    token: sheet.identityToken,
    nonce,
  });
  if (exchange.error) {
    latestAppleCredential = undefined;
    completedAppleSignIn = false;
    throw exchange.error;
  }
  return credential;
}

export function takeCompletedAppleSignIn(): boolean {
  const completed = completedAppleSignIn;
  completedAppleSignIn = false;
  return completed;
}

export function appleCredentialOf(): AppleProviderCredential | undefined {
  return latestAppleCredential;
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
