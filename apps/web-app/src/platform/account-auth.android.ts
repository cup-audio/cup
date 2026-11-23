import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { AppleProviderCredential } from "@cup/listener-api.routes";

import { SignInCancelledError, UserFacingError } from "#src/errors.js";
import type { AppleSignInOptions, GoogleSignInOptions } from "#src/platform/account-auth.js";
import { watchAppState } from "#src/platform/account-auth.native.js";
import { AUTH_CALLBACK_URL, webAuthentication } from "#src/platform/web-authentication.js";
import { reportFailure } from "#src/report-failure.js";

export { initializeAuthStorage, watchAppState } from "#src/platform/account-auth.native.js";

const CANCELLATION_GRACE_PERIOD_MILLISECONDS = 3_000;
const APPLE_SIGN_IN_FAILED = "Apple sign-in could not be completed. Try again.";

let completedAppleSignIn = false;
let heldAppleCredential: AppleProviderCredential | undefined;

type ExchangingClient = { auth: Pick<SupabaseClient["auth"], "exchangeCodeForSession"> };

export async function signInWithApple(
  client: { auth: Pick<SupabaseClient["auth"], "signInWithOAuth" | "exchangeCodeForSession"> },
  { fresh }: AppleSignInOptions,
) {
  const authorization = await client.auth.signInWithOAuth({
    provider: "apple",
    options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true, scopes: "email" },
  });
  if (authorization.error) {
    throw authorization.error;
  }
  const signedIn = webAuthentication
    .authenticate({
      url: authorization.data.url,
      sessionStorage: sessionStorageSnapshot(),
      ephemeral: fresh,
    })
    .then(
      ({ url }) => exchangeCallback(client, url),
      (error: unknown) => {
        throw isCancelledAuthentication(error)
          ? new SignInCancelledError({ provider: "Apple", cause: error })
          : new UserFacingError({ title: APPLE_SIGN_IN_FAILED, cause: error });
      },
    );
  const returnWithoutCallback = cancelAfterReturningWithoutCallback();
  try {
    await Promise.race([signedIn, returnWithoutCallback.cancellation]);
  } finally {
    returnWithoutCallback.stop();
  }
}

export async function completePendingSignIn(client: ExchangingClient): Promise<void> {
  webAuthentication
    .addListener("pendingCallback", () => {
      void exchangePendingCallback(client);
    })
    .catch(reportFailure("Failed to listen for sign-ins Android delivers late"));
  await exchangePendingCallback(client);
}

async function exchangePendingCallback(client: ExchangingClient): Promise<void> {
  try {
    const { url, sessionStorage } = await webAuthentication.takePendingCallback();
    if (url === undefined) {
      return;
    }
    if (sessionStorage !== undefined) {
      restoreSessionStorage(sessionStorage);
    }
    await exchangeCallback(client, url);
  } catch (error) {
    reportFailure("Failed to complete the sign-in Android delivered while Cup was not running")(
      error,
    );
  }
}

function sessionStorageSnapshot(): string {
  const entries: Record<string, string> = {};
  for (let index = 0; index < window.sessionStorage.length; index++) {
    const key = window.sessionStorage.key(index);
    const value = key === null ? null : window.sessionStorage.getItem(key);
    if (key !== null && value !== null) {
      entries[key] = value;
    }
  }
  return JSON.stringify(entries);
}

function restoreSessionStorage(snapshot: string) {
  const entries = z
    .string()
    .transform((text, context) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        context.addIssue({ code: "custom", message: "The snapshot is not JSON." });
        return z.NEVER;
      }
    })
    .pipe(z.record(z.string(), z.string()))
    .safeParse(snapshot);
  if (!entries.success) {
    return;
  }
  for (const [key, value] of Object.entries(entries.data)) {
    if (window.sessionStorage.getItem(key) === null) {
      window.sessionStorage.setItem(key, value);
    }
  }
}

function cancelAfterReturningWithoutCallback() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopWatching: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    let hasLeft = false;
    stopWatching = watchAppState((isActive) => {
      if (!isActive) {
        hasLeft = true;
        clearTimeout(timer);
        timer = undefined;
        return;
      }
      if (hasLeft && timer === undefined) {
        timer = setTimeout(
          () => reject(new SignInCancelledError({ provider: "Apple" })),
          CANCELLATION_GRACE_PERIOD_MILLISECONDS,
        );
      }
    });
  });
  return {
    cancellation,
    stop: () => {
      clearTimeout(timer);
      stopWatching?.();
    },
  };
}

async function exchangeCallback(client: ExchangingClient, callbackUrl: string): Promise<void> {
  const callback = new URL(callbackUrl);
  const code = callback.searchParams.get("code");
  if (code === null || code === "") {
    const fragment = new URLSearchParams(callback.hash.slice(1));
    const description =
      callback.searchParams.get("error_description") ?? fragment.get("error_description");
    throw new UserFacingError({
      title: APPLE_SIGN_IN_FAILED,
      cause: new Error(description ?? "Sign-in did not complete."),
    });
  }
  const exchange = await client.auth.exchangeCodeForSession(code);
  if (exchange.error) {
    throw exchange.error;
  }
  const refreshToken = exchange.data.session.provider_refresh_token;
  heldAppleCredential = refreshToken ? { provider: "apple", refreshToken } : undefined;
  completedAppleSignIn = true;
}

export function appleCredentialOf(): AppleProviderCredential | undefined {
  return heldAppleCredential;
}

export function takeCompletedAppleSignIn(): boolean {
  const completed = completedAppleSignIn;
  completedAppleSignIn = false;
  return completed;
}

function isCancelledAuthentication(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "CANCELED";
}

const CANCELLED_BY_PERSON_MESSAGES = new Set([
  "[16] Cancelled by user.",
  "The user canceled the sign-in flow.",
]);

export async function signInWithGoogle(
  client: { auth: Pick<SupabaseClient["auth"], "signInWithIdToken"> },
  googleClientId: string | undefined,
  { fresh }: GoogleSignInOptions,
) {
  const { GoogleSignIn, ErrorCode } = await import("@capawesome/capacitor-google-sign-in");
  if (!googleClientId) {
    throw new Error("Sign-in is temporarily unavailable.");
  }
  await GoogleSignIn.initialize({ clientId: googleClientId });
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = Array.from(nonceBytes, (value) => value.toString(16).padStart(2, "0")).join("");
  const hashedNonce = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce))),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  if (fresh) {
    await GoogleSignIn.signOut();
  }
  let result;
  try {
    result = await GoogleSignIn.signIn({ nonce: hashedNonce });
  } catch (error) {
    if (isCancelledByPerson(error, ErrorCode.SignInCanceled)) {
      throw new SignInCancelledError({ cause: error });
    }
    throw new UserFacingError({
      title: "Google sign-in could not be completed. Try again.",
      cause: error,
    });
  }
  const exchange = await client.auth.signInWithIdToken({
    provider: "google",
    token: result.idToken,
    nonce,
  });
  if (exchange.error) {
    throw exchange.error;
  }
}

export async function clearNativeSignIn(): Promise<void> {
  const { GoogleSignIn } = await import("@capawesome/capacitor-google-sign-in");
  await GoogleSignIn.signOut();
}

function isCancelledByPerson(error: unknown, cancellationCode: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === cancellationCode &&
    CANCELLED_BY_PERSON_MESSAGES.has(error.message)
  );
}
