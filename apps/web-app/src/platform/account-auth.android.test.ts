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

type AppleSignInRecord = {
  oauthOptions?: unknown;
  authenticatedUrl?: unknown;
  authenticatedSessionStorage?: unknown;
  authenticatedEphemeral?: unknown;
  exchangedCodes: string[];
  outcome?: { status: "resolved" } | { status: "rejected"; name: string; message: string };
};

type AuthenticationOutcome = { url: string } | { code: string; message: string };

async function startAppleSignIn(page: Page, { fresh = false } = {}): Promise<void> {
  await page.clock.install();
  await page.addInitScript(() => {
    const appStateListeners: Array<(state: { isActive: boolean }) => void> = [];
    let finish: ((outcome: { url: string } | { error: Error }) => void) | undefined;
    Object.assign(window, {
      androidBridge: {},
      appleSignIn: { exchangedCodes: [] },
      setAppActive: (isActive: boolean) => {
        for (const listener of appStateListeners) {
          listener({ isActive });
        }
      },
      finishAuthentication: (outcome: { url: string } | { code: string; message: string }) => {
        finish?.(
          "url" in outcome
            ? outcome
            : { error: Object.assign(new Error(outcome.message), { code: outcome.code }) },
        );
      },
      Capacitor: {
        PluginHeaders: [
          {
            name: "WebAuthentication",
            methods: [
              { name: "authenticate", rtype: "promise" },
              { name: "takePendingCallback", rtype: "promise" },
            ],
          },
          {
            name: "App",
            methods: [
              { name: "addListener" },
              { name: "removeListener", rtype: "promise" },
              { name: "getState", rtype: "promise" },
            ],
          },
        ],
        nativeCallback: (
          plugin: string,
          _method: string,
          options: { eventName: string },
          listener: (state: { isActive: boolean }) => void,
        ) => {
          if (plugin === "App" && options.eventName === "appStateChange") {
            appStateListeners.push(listener);
          }
          return `${plugin}-${options.eventName}`;
        },
        nativePromise: async (
          plugin: string,
          method: string,
          options: { url: string; sessionStorage?: string; ephemeral?: boolean },
        ) => {
          if (plugin === "App") {
            return method === "getState" ? { isActive: true } : {};
          }
          if (plugin === "WebAuthentication" && method === "authenticate") {
            Reflect.set(Reflect.get(window, "appleSignIn"), "authenticatedUrl", options.url);
            Reflect.set(
              Reflect.get(window, "appleSignIn"),
              "authenticatedSessionStorage",
              options.sessionStorage,
            );
            Reflect.set(
              Reflect.get(window, "appleSignIn"),
              "authenticatedEphemeral",
              options.ephemeral,
            );
            const outcome = await new Promise<{ url: string } | { error: Error }>((resolve) => {
              finish = resolve;
            });
            if ("error" in outcome) {
              throw outcome.error;
            }
            return outcome;
          }
          throw new Error(`Unexpected native call ${plugin}.${method}`);
        },
      },
    });
  });
  await page.goto("");
  await page.clock.pauseAt(Date.now() + 60_000);
  await page.evaluate((isFresh) => {
    const record: AppleSignInRecord = Reflect.get(window, "appleSignIn");
    const client = {
      auth: {
        signInWithOAuth: async (credentials: { options: unknown }) => {
          record.oauthOptions = credentials.options;
          return {
            data: { url: "https://auth.example.test/auth/v1/authorize?provider=apple" },
            error: null,
          };
        },
        exchangeCodeForSession: async (code: string) => {
          record.exchangedCodes.push(code);
          return {
            data: { session: { provider_refresh_token: `apple-refresh-token-for-${code}` } },
            error: null,
          };
        },
      },
    };
    const modulePath = "/src/platform/account-auth.android.ts";
    const signIn = async () => {
      try {
        const { signInWithApple } = await import(modulePath);
        await signInWithApple(client, { fresh: isFresh });
        record.outcome = { status: "resolved" };
      } catch (error) {
        record.outcome = {
          status: "rejected",
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    };
    void signIn();
  }, fresh);
  await expect
    .poll(() => appleSignInRecord(page).then((record) => record.authenticatedUrl))
    .toBe("https://auth.example.test/auth/v1/authorize?provider=apple");
}

function appleSignInRecord(page: Page): Promise<AppleSignInRecord> {
  return page.evaluate(() => structuredClone(Reflect.get(window, "appleSignIn")));
}

function finishAuthentication(page: Page, outcome: AuthenticationOutcome): Promise<void> {
  return page.evaluate((finished) => {
    Reflect.get(window, "finishAuthentication")(finished);
  }, outcome);
}

function setAppActive(page: Page, isActive: boolean): Promise<void> {
  return page.evaluate((active) => {
    Reflect.get(window, "setAppActive")(active);
  }, isActive);
}

test("Apple sign-in runs Supabase's Apple OAuth in a browser tab and exchanges the returned code", async ({
  page,
}) => {
  await startAppleSignIn(page);

  await setAppActive(page, false);
  await finishAuthentication(page, { url: "audio.cup.app://auth/callback?code=the-code" });
  await setAppActive(page, true);

  await expect
    .poll(() => appleSignInRecord(page))
    .toEqual({
      oauthOptions: {
        redirectTo: "audio.cup.app://auth/callback",
        skipBrowserRedirect: true,
        scopes: "email",
      },
      authenticatedUrl: "https://auth.example.test/auth/v1/authorize?provider=apple",
      authenticatedSessionStorage: "{}",
      authenticatedEphemeral: false,
      exchangedCodes: ["the-code"],
      outcome: { status: "resolved" },
    });
});

test("a fresh Apple sign-in, as the deletion confirmation asks for, opens an ephemeral browser tab", async ({
  page,
}) => {
  await startAppleSignIn(page, { fresh: true });

  expect((await appleSignInRecord(page)).authenticatedEphemeral).toBe(true);
});

test("a browser tab the plugin cancels, as when a new sign-in replaces it, ends Apple sign-in as a cancellation", async ({
  page,
}) => {
  await startAppleSignIn(page);

  await finishAuthentication(page, { code: "CANCELED", message: "Sign-in was cancelled." });

  await expect
    .poll(() => appleSignInRecord(page))
    .toMatchObject({
      exchangedCodes: [],
      outcome: {
        status: "rejected",
        name: "SignInCancelledError",
        message: "Apple sign-in was cancelled.",
      },
    });
});

for (const outcome of [
  { code: "FAILED", message: "No browser could open." },
  { url: "audio.cup.app://auth/callback?error=server_error&error_description=Unable+to+exchange" },
] satisfies AuthenticationOutcome[]) {
  test(`any other ending of the browser tab shows a message to try again: ${JSON.stringify(outcome)}`, async ({
    page,
  }) => {
    await startAppleSignIn(page);

    await finishAuthentication(page, outcome);

    await expect
      .poll(() => appleSignInRecord(page))
      .toMatchObject({
        exchangedCodes: [],
        outcome: {
          status: "rejected",
          name: "UserFacingError",
          message: "Apple sign-in could not be completed. Try again.",
        },
      });
  });
}

test("Cup returning to the foreground without a callback ends Apple sign-in as a cancellation after 3 seconds", async ({
  page,
}) => {
  await startAppleSignIn(page);
  await setAppActive(page, false);
  await setAppActive(page, true);

  await page.clock.runFor(2_900);
  expect((await appleSignInRecord(page)).outcome).toBeUndefined();
  await page.clock.runFor(200);

  await expect
    .poll(() => appleSignInRecord(page))
    .toMatchObject({
      exchangedCodes: [],
      outcome: {
        status: "rejected",
        name: "SignInCancelledError",
        message: "Apple sign-in was cancelled.",
      },
    });
});

test("a callback within the grace period after Cup returns still signs in", async ({ page }) => {
  await startAppleSignIn(page);
  await setAppActive(page, false);
  await setAppActive(page, true);

  await page.clock.runFor(2_000);
  await finishAuthentication(page, { url: "audio.cup.app://auth/callback?code=the-code" });
  await page.clock.runFor(2_000);

  await expect
    .poll(() => appleSignInRecord(page))
    .toMatchObject({
      exchangedCodes: ["the-code"],
      outcome: { status: "resolved" },
    });
});

test("a callback arriving after the cancellation is still exchanged", async ({ page }) => {
  await startAppleSignIn(page);
  await setAppActive(page, false);
  await setAppActive(page, true);
  await page.clock.runFor(3_100);
  await expect
    .poll(() => appleSignInRecord(page).then((record) => record.outcome))
    .toMatchObject({ status: "rejected", name: "SignInCancelledError" });

  await finishAuthentication(page, { url: "audio.cup.app://auth/callback?code=the-late-code" });

  await expect
    .poll(() => appleSignInRecord(page).then((record) => record.exchangedCodes))
    .toEqual(["the-late-code"]);
});

test("Apple sign-in hands the browser tab the session storage to keep while Cup may be killed", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("cup_pending_conversion", "the submitted request");
  });

  await startAppleSignIn(page);

  expect((await appleSignInRecord(page)).authenticatedSessionStorage).toBe(
    JSON.stringify({ cup_pending_conversion: "the submitted request" }),
  );
});

test("a callback Android delivers after Cup already asked for a pending callback at startup is still exchanged", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let pendingUrl: string | undefined;
    const listeners: Array<(event: unknown) => void> = [];
    Object.assign(window, {
      androidBridge: {},
      exchangedCodes: [],
      deliverLateCallback: (url: string) => {
        pendingUrl = url;
        for (const listener of listeners) {
          listener({});
        }
      },
      Capacitor: {
        PluginHeaders: [
          {
            name: "WebAuthentication",
            methods: [
              { name: "takePendingCallback", rtype: "promise" },
              { name: "addListener" },
              { name: "removeListener", rtype: "promise" },
            ],
          },
        ],
        nativeCallback: (
          plugin: string,
          _method: string,
          options: { eventName: string },
          listener: (event: unknown) => void,
        ) => {
          if (plugin === "WebAuthentication" && options.eventName === "pendingCallback") {
            listeners.push(listener);
          }
          return `${plugin}-${options.eventName}`;
        },
        nativePromise: async (plugin: string, method: string) => {
          if (plugin === "WebAuthentication" && method === "takePendingCallback") {
            const url = pendingUrl;
            pendingUrl = undefined;
            return url === undefined ? {} : { url };
          }
          throw new Error(`Unexpected native call ${plugin}.${method}`);
        },
      },
    });
  });
  await page.goto("");
  await page.evaluate(async () => {
    const exchangedCodes: string[] = Reflect.get(window, "exchangedCodes");
    const client = {
      auth: {
        exchangeCodeForSession: async (code: string) => {
          exchangedCodes.push(code);
          return { data: { session: { provider_refresh_token: "the-late-refresh-token" } } };
        },
      },
    };
    const modulePath = "/src/platform/account-auth.android.ts";
    const { completePendingSignIn } = await import(modulePath);
    await completePendingSignIn(client);
  });
  expect(await page.evaluate(() => structuredClone(Reflect.get(window, "exchangedCodes")))).toEqual(
    [],
  );

  await page.evaluate(() => {
    Reflect.get(window, "deliverLateCallback")("audio.cup.app://auth/callback?code=late-code");
  });

  await expect
    .poll(() => page.evaluate(() => structuredClone(Reflect.get(window, "exchangedCodes"))))
    .toEqual(["late-code"]);
  expect(await takeCompletedAppleSignIn(page)).toEqual([true, false]);
});

test("a callback Android delivered while Cup was not running is exchanged on startup with the session storage the sign-in started from", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      androidBridge: {},
      Capacitor: {
        PluginHeaders: [
          {
            name: "WebAuthentication",
            methods: [{ name: "takePendingCallback", rtype: "promise" }],
          },
        ],
        nativePromise: async (plugin: string, method: string) => {
          if (plugin === "WebAuthentication" && method === "takePendingCallback") {
            return {
              url: "audio.cup.app://auth/callback?code=the-delivered-code",
              sessionStorage: JSON.stringify({ cup_pending_conversion: "the submitted request" }),
            };
          }
          throw new Error(`Unexpected native call ${plugin}.${method}`);
        },
      },
    });
  });
  await page.goto("");

  const exchanges = await page.evaluate(async () => {
    const exchanged: Array<{ code: string; pendingConversion: string | null }> = [];
    const client = {
      auth: {
        exchangeCodeForSession: async (code: string) => {
          exchanged.push({
            code,
            pendingConversion: window.sessionStorage.getItem("cup_pending_conversion"),
          });
          return {
            data: { session: { provider_refresh_token: "the-delivered-refresh-token" } },
            error: null,
          };
        },
      },
    };
    const modulePath = "/src/platform/account-auth.android.ts";
    const { completePendingSignIn } = await import(modulePath);
    await completePendingSignIn(client);
    return exchanged;
  });

  expect(exchanges).toEqual([
    { code: "the-delivered-code", pendingConversion: "the submitted request" },
  ]);
  expect(await takeCompletedAppleSignIn(page)).toEqual([true, false]);
  expect(await heldAppleCredential(page)).toEqual({
    provider: "apple",
    refreshToken: "the-delivered-refresh-token",
  });
});

test("a completed Apple sign-in is reported once, holding the refresh token its code exchange returned", async ({
  page,
}) => {
  await startAppleSignIn(page);
  expect(await takeCompletedAppleSignIn(page)).toEqual([false, false]);

  await finishAuthentication(page, { url: "audio.cup.app://auth/callback?code=the-code" });
  await expect
    .poll(() => appleSignInRecord(page).then((record) => record.outcome))
    .toEqual({ status: "resolved" });

  expect(await takeCompletedAppleSignIn(page)).toEqual([true, false]);
  expect(await heldAppleCredential(page)).toEqual({
    provider: "apple",
    refreshToken: "apple-refresh-token-for-the-code",
  });
});

test("a cancelled Apple sign-in is not reported as completed", async ({ page }) => {
  await startAppleSignIn(page);

  await finishAuthentication(page, { code: "CANCELED", message: "Sign-in was cancelled." });
  await expect
    .poll(() => appleSignInRecord(page).then((record) => record.outcome?.status))
    .toBe("rejected");

  expect(await takeCompletedAppleSignIn(page)).toEqual([false, false]);
  expect(await heldAppleCredential(page)).toBeUndefined();
});

function heldAppleCredential(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const modulePath = "/src/platform/account-auth.android.ts";
    const module = await import(modulePath);
    return module.appleCredentialOf();
  });
}

function takeCompletedAppleSignIn(page: Page): Promise<boolean[]> {
  return page.evaluate(async () => {
    const modulePath = "/src/platform/account-auth.android.ts";
    const module = await import(modulePath);
    return [module.takeCompletedAppleSignIn(), module.takeCompletedAppleSignIn()];
  });
}
