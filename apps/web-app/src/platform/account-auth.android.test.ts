import type { Page } from "@playwright/test";

import type { signInWithGoogle } from "#src/platform/account-auth.android.ts";
import { expect, test } from "#src/test-utils/component-test.ts";

type PluginFailure = { code: string | undefined; message: string };

async function signInFailingWith(
  { page, mount }: { page: Page; mount: (story: string) => Promise<unknown> },
  failure: PluginFailure,
): Promise<{
  outcome: "resolved" | "rejected";
  name?: string;
  message?: string;
  exchanged: boolean;
}> {
  await page.addInitScript((pluginFailure: PluginFailure) => {
    Object.assign(window, {
      androidBridge: {},
      Capacitor: {
        PluginHeaders: [
          {
            name: "GoogleSignIn",
            methods: [
              { name: "initialize", rtype: "promise" },
              { name: "signIn", rtype: "promise" },
              { name: "signOut", rtype: "promise" },
            ],
          },
        ],
        nativePromise: async (_plugin: string, method: string) => {
          if (method === "signIn") {
            throw Object.assign(new Error(pluginFailure.message), { code: pluginFailure.code });
          }
          return {};
        },
      },
    });
  }, failure);
  await mount("routes/index/LandingPage");

  return page.evaluate(async () => {
    const modulePath = "/src/platform/account-auth.android.ts";
    const module: { signInWithGoogle: typeof signInWithGoogle } = await import(modulePath);
    let exchanged = false;
    const client: Parameters<typeof signInWithGoogle>[0] = {
      auth: {
        signInWithIdToken: async () => {
          exchanged = true;
          throw new Error("The ID token reached Supabase.");
        },
      },
    };
    try {
      await module.signInWithGoogle(client, "client-id.apps.googleusercontent.com", {
        fresh: false,
        chooseAccount: false,
      });
      return { outcome: "resolved" as const, exchanged };
    } catch (error) {
      return {
        outcome: "rejected" as const,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        exchanged,
      };
    }
  });
}

for (const message of ["[16] Cancelled by user.", "The user canceled the sign-in flow."]) {
  test(`a sign-in the person cancelled rejects as a cancellation: ${message}`, async ({
    mount,
    page,
  }) => {
    const result = await signInFailingWith({ page, mount }, { code: "SIGN_IN_CANCELED", message });
    expect(result).toEqual({
      outcome: "rejected",
      name: "SignInCancelledError",
      message: "Google sign-in was cancelled.",
      exchanged: false,
    });
  });
}

for (const failure of [
  { code: "SIGN_IN_CANCELED", message: "[16] Account reauth failed." },
  { code: "NO_CREDENTIAL_AVAILABLE", message: "No credential is available." },
  { code: undefined, message: "TYPE_UNKNOWN: [8] Unknown error" },
] satisfies PluginFailure[]) {
  test(`any other plugin failure shows a user-facing message: ${failure.message}`, async ({
    mount,
    page,
  }) => {
    const result = await signInFailingWith({ page, mount }, failure);
    expect(result).toEqual({
      outcome: "rejected",
      name: "UserFacingError",
      message: "Google sign-in could not be completed. Try again.",
      exchanged: false,
    });
  });
}
