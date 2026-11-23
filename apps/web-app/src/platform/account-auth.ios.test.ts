import type { Page } from "@playwright/test";
import crypto from "node:crypto";

import { expect, test } from "#src/test-utils/component-test.ts";

type SignInRecord = {
  oauthOptions?: unknown;
  authenticatedUrl?: unknown;
  exchangedCode?: unknown;
  error?: string;
};

async function signIn(
  page: Page,
  callbackUrl: string,
  signInOptions: { fresh: boolean; chooseAccount: boolean } = {
    fresh: false,
    chooseAccount: false,
  },
): Promise<SignInRecord> {
  await page.addInitScript((url) => {
    Object.assign(window, {
      webkit: { messageHandlers: { bridge: {} } },
      Capacitor: {
        PluginHeaders: [
          { name: "WebAuthentication", methods: [{ name: "authenticate", rtype: "promise" }] },
        ],
        nativePromise: async (plugin: string, method: string, options: { url: string }) => {
          if (plugin !== "WebAuthentication" || method !== "authenticate") {
            throw new Error(`Unexpected native call ${plugin}.${method}`);
          }
          Object.assign(window, { authenticatedUrl: options.url });
          return { url };
        },
      },
    });
  }, callbackUrl);
  await page.goto("");
  return page.evaluate(async (requestedOptions) => {
    const modulePath = "/src/platform/account-auth.ios.ts";
    const { signInWithGoogle } = await import(modulePath);
    const record: SignInRecord = {};
    const client = {
      auth: {
        signInWithOAuth: async (credentials: { options: unknown }) => {
          record.oauthOptions = credentials.options;
          return {
            data: { url: "https://auth.example.test/auth/v1/authorize?state=1" },
            error: null,
          };
        },
        exchangeCodeForSession: async (code: string) => {
          record.exchangedCode = code;
          return { data: {}, error: null };
        },
      },
    };
    try {
      await signInWithGoogle(client, undefined, requestedOptions);
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
    record.authenticatedUrl = Reflect.get(window, "authenticatedUrl");
    return record;
  }, signInOptions);
}

test("signs in through the system browser sheet and exchanges the returned code", async ({
  page,
}) => {
  const record = await signIn(page, "audio.cup.app://auth/callback?code=the-code");

  expect(record).toEqual({
    oauthOptions: {
      redirectTo: "audio.cup.app://auth/callback",
      skipBrowserRedirect: true,
      queryParams: {},
    },
    authenticatedUrl: "https://auth.example.test/auth/v1/authorize?state=1",
    exchangedCode: "the-code",
  });
});

test("asks Google for its account chooser when the session lifecycle asks for it", async ({
  page,
}) => {
  const record = await signIn(page, "audio.cup.app://auth/callback?code=the-code", {
    fresh: false,
    chooseAccount: true,
  });

  expect(record.oauthOptions).toMatchObject({ queryParams: { prompt: "select_account" } });
  expect(record.exchangedCode).toBe("the-code");
});

test("asks Google for the account chooser and a new authentication on a fresh sign-in", async ({
  page,
}) => {
  const record = await signIn(page, "audio.cup.app://auth/callback?code=the-code", {
    fresh: true,
    chooseAccount: false,
  });

  expect(record.oauthOptions).toMatchObject({
    queryParams: { prompt: "select_account", max_age: "0" },
  });
  expect(record.exchangedCode).toBe("the-code");
});

test("reports the provider's error and exchanges nothing when the callback has no code", async ({
  page,
}) => {
  const record = await signIn(
    page,
    "audio.cup.app://auth/callback#error=access_denied&error_description=The+user+declined",
  );

  expect(record.error).toBe("The user declined");
  expect(record.exchangedCode).toBeUndefined();
});

type AppleSignInRecord = {
  outcome: "resolved" | "rejected";
  credential?: unknown;
  name?: string;
  message?: string;
  sheetNonce?: unknown;
  exchange?: { provider: string; token: string; nonce: string };
};

type AppleSheetAnswer =
  | { identityToken: string; authorizationCode: string }
  | { failure: { code: string; message: string } };

async function signInWithApple(
  page: Page,
  sheetAnswer: AppleSheetAnswer,
  exchangeError?: string,
): Promise<AppleSignInRecord> {
  await page.addInitScript((answer: AppleSheetAnswer) => {
    Object.assign(window, {
      webkit: { messageHandlers: { bridge: {} } },
      Capacitor: {
        PluginHeaders: [{ name: "AppleSignIn", methods: [{ name: "signIn", rtype: "promise" }] }],
        nativePromise: async (plugin: string, method: string, options: { nonce: string }) => {
          if (plugin !== "AppleSignIn" || method !== "signIn") {
            throw new Error(`Unexpected native call ${plugin}.${method}`);
          }
          Object.assign(window, { sheetNonce: options.nonce });
          if ("failure" in answer) {
            throw Object.assign(new Error(answer.failure.message), { code: answer.failure.code });
          }
          return answer;
        },
      },
    });
  }, sheetAnswer);
  await page.goto("");
  return page.evaluate(async (supabaseError) => {
    const modulePath = "/src/platform/account-auth.ios.ts";
    const module: { signInWithApple: (client: unknown) => Promise<unknown> } = await import(
      modulePath
    );
    const record: AppleSignInRecord = { outcome: "resolved" };
    const client = {
      auth: {
        signInWithIdToken: async (credentials: {
          provider: string;
          token: string;
          nonce: string;
        }) => {
          record.exchange = credentials;
          return supabaseError === null
            ? { data: {}, error: null }
            : { data: {}, error: new Error(supabaseError) };
        },
      },
    };
    try {
      record.credential = await module.signInWithApple(client);
    } catch (error) {
      record.outcome = "rejected";
      record.name = error instanceof Error ? error.name : typeof error;
      record.message = error instanceof Error ? error.message : String(error);
    }
    record.sheetNonce = Reflect.get(window, "sheetNonce");
    return record;
  }, exchangeError ?? null);
}

test("signs in with Apple's native sheet, exchanging its identity token and the raw nonce whose SHA-256 the sheet got", async ({
  page,
}) => {
  const record = await signInWithApple(page, {
    identityToken: "the-identity-token",
    authorizationCode: "the-authorization-code",
  });

  expect(record.outcome).toBe("resolved");
  expect(record.exchange).toEqual({
    provider: "apple",
    token: "the-identity-token",
    nonce: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  const rawNonce = record.exchange?.nonce ?? "";
  expect(record.sheetNonce).toBe(crypto.createHash("sha256").update(rawNonce).digest("hex"));
  expect(record.credential).toEqual({
    provider: "apple",
    authorizationCode: "the-authorization-code",
  });
});

test("asks Apple's sheet with a new nonce on every sign-in", async ({ page }) => {
  const answer = { identityToken: "the-identity-token", authorizationCode: "the-code" };
  const first = await signInWithApple(page, answer);
  const second = await signInWithApple(page, answer);

  expect(first.sheetNonce).not.toBe(second.sheetNonce);
});

test("a sheet the person closed rejects as a cancellation and exchanges nothing", async ({
  page,
}) => {
  const record = await signInWithApple(page, {
    failure: { code: "CANCELED", message: "Sign in with Apple was cancelled." },
  });

  expect(record).toMatchObject({
    outcome: "rejected",
    name: "SignInCancelledError",
    message: "Apple sign-in was cancelled.",
  });
  expect(record.exchange).toBeUndefined();
});

for (const code of ["FAILED", "IN_PROGRESS"]) {
  test(`a sheet that rejects with ${code} asks the person to try again and exchanges nothing`, async ({
    page,
  }) => {
    const record = await signInWithApple(page, {
      failure: { code, message: "The operation couldn't be completed. (1000)" },
    });

    expect(record).toMatchObject({
      outcome: "rejected",
      name: "UserFacingError",
      message: "Apple sign-in could not be completed. Try again.",
    });
    expect(record.exchange).toBeUndefined();
  });
}

test("rejects with Supabase's error when it refuses the identity token", async ({ page }) => {
  const record = await signInWithApple(
    page,
    { identityToken: "the-identity-token", authorizationCode: "the-code" },
    "Nonces mismatch",
  );

  expect(record).toMatchObject({ outcome: "rejected", message: "Nonces mismatch" });
  expect(record.credential).toBeUndefined();
});

test("keeps the account session in the Keychain readable after the first unlock, for refreshes while locked", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      webkit: { messageHandlers: { bridge: {} } },
      Capacitor: {
        PluginHeaders: [
          {
            name: "SecureStorage",
            methods: ["internalSetItem", "internalGetItem", "internalRemoveItem"].map((name) => ({
              name,
              rtype: "promise",
            })),
          },
        ],
        nativePromise: async (plugin: string, method: string, options: unknown) => {
          if (plugin === "SecureStorage" && method === "internalSetItem") {
            Object.assign(window, { storedItem: options });
          }
          return {};
        },
      },
    });
  });
  await page.goto("");

  const storedItem = await page.evaluate(async () => {
    const modulePath = "/src/platform/account-auth.ios.ts";
    const module: {
      initializeAuthStorage: (
        keys: readonly string[],
      ) => Promise<{ storage: { setItem: (key: string, value: string) => Promise<void> } }>;
    } = await import(modulePath);
    const { storage } = await module.initializeAuthStorage(["cup-account-session"]);
    await storage.setItem("cup-account-session", "the Apple session");
    return Reflect.get(window, "storedItem");
  });

  expect(storedItem).toMatchObject({ data: "the Apple session", access: 2 });
});
