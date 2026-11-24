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
  completedSignIns?: unknown;
  heldCredential?: unknown;
  name?: string;
  message?: string;
  sheetNonce?: unknown;
  exchange?: { provider: string; token: string; nonce: string };
  userUpdates: unknown[];
  reports: unknown[];
};

type AppleSheetAnswer =
  | { identityToken: string; authorizationCode: string; givenName?: string; familyName?: string }
  | { failure: { code: string; message: string } };

type SupabaseAnswers = { exchangeError?: string; userUpdateError?: string };

async function signInWithApple(
  page: Page,
  sheetAnswer: AppleSheetAnswer,
  supabaseAnswers: SupabaseAnswers = {},
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
  return page.evaluate(async ({ exchangeError, userUpdateError }) => {
    const modulePath = "/src/platform/account-auth.ios.ts";
    const module: {
      createSignInWithApple: (
        report: (message: string) => (error: unknown) => void,
      ) => (client: unknown) => Promise<unknown>;
      takeCompletedAppleSignIn: () => boolean;
      appleCredentialOf: () => unknown;
    } = await import(modulePath);
    const record: AppleSignInRecord = { outcome: "resolved", userUpdates: [], reports: [] };
    const report = (message: string) => (error: unknown) => {
      record.reports.push([message, error instanceof Error ? error.message : error]);
    };
    const client = {
      auth: {
        signInWithIdToken: async (credentials: {
          provider: string;
          token: string;
          nonce: string;
        }) => {
          record.exchange = credentials;
          return exchangeError === undefined
            ? { data: {}, error: null }
            : { data: {}, error: new Error(exchangeError) };
        },
        updateUser: async (attributes: unknown) => {
          record.userUpdates.push(attributes);
          return userUpdateError === undefined
            ? { data: { user: {} }, error: null }
            : { data: { user: null }, error: new Error(userUpdateError) };
        },
      },
    };
    try {
      record.credential = await module.createSignInWithApple(report)(client);
    } catch (error) {
      record.outcome = "rejected";
      record.name = error instanceof Error ? error.name : typeof error;
      record.message = error instanceof Error ? error.message : String(error);
    }
    record.sheetNonce = Reflect.get(window, "sheetNonce");
    record.completedSignIns = [
      module.takeCompletedAppleSignIn(),
      module.takeCompletedAppleSignIn(),
    ];
    record.heldCredential = module.appleCredentialOf();
    return record;
  }, supabaseAnswers);
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

test("after a native Apple sign-in, tells once that it completed and holds the sheet's authorization code for the deletion confirmation or revocation", async ({
  page,
}) => {
  const record = await signInWithApple(page, {
    identityToken: "the-identity-token",
    authorizationCode: "the-authorization-code",
  });

  expect(record.completedSignIns).toEqual([true, false]);
  expect(record.heldCredential).toEqual({
    provider: "apple",
    authorizationCode: "the-authorization-code",
  });
});

test("a native Apple sign-in that Supabase refuses completes no Apple sign-in and holds no code", async ({
  page,
}) => {
  const record = await signInWithApple(
    page,
    { identityToken: "the-identity-token", authorizationCode: "the-code" },
    { exchangeError: "Nonces mismatch" },
  );

  expect(record.completedSignIns).toEqual([false, false]);
  expect(record.heldCredential).toBeUndefined();
});

test("stores the name Apple's sheet returned on the Supabase user, joined and trimmed as Supabase's Apple provider does", async ({
  page,
}) => {
  const record = await signInWithApple(page, {
    identityToken: "the-identity-token",
    authorizationCode: "the-authorization-code",
    givenName: " Ada",
    familyName: "Lovelace ",
  });

  expect(record.outcome).toBe("resolved");
  expect(record.userUpdates).toEqual([
    { data: { name: "Ada Lovelace", full_name: "Ada Lovelace" } },
  ]);
  expect(record.reports).toEqual([]);
});

for (const [description, name] of [
  ["no name, as on every authorization after the first", {}],
  ["a blank name", { givenName: " ", familyName: "" }],
] as const) {
  test(`leaves the Supabase user's name alone when Apple's sheet returns ${description}`, async ({
    page,
  }) => {
    const record = await signInWithApple(page, {
      identityToken: "the-identity-token",
      authorizationCode: "the-authorization-code",
      ...name,
    });

    expect(record.outcome).toBe("resolved");
    expect(record.userUpdates).toEqual([]);
  });
}

test("a name Supabase fails to store still signs in, holds Apple's code, and reports the failure", async ({
  page,
}) => {
  const record = await signInWithApple(
    page,
    {
      identityToken: "the-identity-token",
      authorizationCode: "the-authorization-code",
      givenName: "Ada",
      familyName: "Lovelace",
    },
    { userUpdateError: "Network request failed" },
  );

  expect(record.outcome).toBe("resolved");
  expect(record.credential).toEqual({
    provider: "apple",
    authorizationCode: "the-authorization-code",
  });
  expect(record.completedSignIns).toEqual([true, false]);
  expect(record.heldCredential).toEqual({
    provider: "apple",
    authorizationCode: "the-authorization-code",
  });
  expect(record.reports).toEqual([
    ["Failed to store the name Apple returned on the account", "Network request failed"],
  ]);
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
    { exchangeError: "Nonces mismatch" },
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
