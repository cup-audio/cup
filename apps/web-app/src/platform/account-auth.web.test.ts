import type { Page } from "@playwright/test";

import { expect, test } from "#src/test-utils/component-test.ts";

async function signIn(
  page: Page,
  options: { fresh: boolean; chooseAccount: boolean },
): Promise<unknown> {
  await page.goto("");
  return page.evaluate(async (signInOptions) => {
    const modulePath = "/src/platform/account-auth.web.ts";
    const { signInWithGoogle } = await import(modulePath);
    let oauthOptions: unknown;
    const client = {
      auth: {
        signInWithOAuth: async (credentials: { options: unknown }) => {
          oauthOptions = credentials.options;
          return { data: {}, error: null };
        },
      },
    };
    await signInWithGoogle(client, undefined, signInOptions);
    return oauthOptions;
  }, options);
}

test("a normal sign-in leaves Google free to skip its account chooser", async ({ page }) => {
  const oauthOptions = await signIn(page, { fresh: false, chooseAccount: false });

  expect(oauthOptions).toMatchObject({ queryParams: {} });
  expect(oauthOptions).not.toHaveProperty("queryParams.prompt");
  expect(oauthOptions).not.toHaveProperty("queryParams.max_age");
});

test("asks Google for its account chooser when the session lifecycle asks for it", async ({
  page,
}) => {
  const oauthOptions = await signIn(page, { fresh: false, chooseAccount: true });

  expect(oauthOptions).toMatchObject({ queryParams: { prompt: "select_account" } });
  expect(oauthOptions).not.toHaveProperty("queryParams.max_age");
});

test("asks Google for the account chooser and a new authentication on a fresh sign-in", async ({
  page,
}) => {
  const oauthOptions = await signIn(page, { fresh: true, chooseAccount: false });

  expect(oauthOptions).toMatchObject({
    queryParams: { prompt: "select_account", max_age: "0" },
  });
});

test("an Apple sign-in asks Supabase for Apple's OAuth flow with the email scope and no name", async ({
  page,
}) => {
  await page.goto("");
  const oauthCredentials = await page.evaluate(async () => {
    const modulePath = "/src/platform/account-auth.web.ts";
    const { signInWithApple } = await import(modulePath);
    let credentials: unknown;
    const client = {
      auth: {
        signInWithOAuth: async (requested: unknown) => {
          credentials = requested;
          return { data: {}, error: null };
        },
      },
    };
    await signInWithApple(client);
    return credentials;
  });

  expect(oauthCredentials).toEqual({
    provider: "apple",
    options: { redirectTo: expect.stringMatching(/^http/), scopes: "email" },
  });
});

test("after Apple's web flow, reports an error that Supabase's callback returns as a failure, once", async ({
  page,
}) => {
  const reports = await returnFromApple(page, {
    error: "server_error",
    error_code: "unexpected_failure",
    error_description: "Unable to exchange external code",
  });

  expect(reports).toEqual([
    [
      expect.stringContaining("Unable to exchange external code"),
      "Apple sign-in on the web failed",
    ],
  ]);
});

test("after Apple's web flow, reports nothing when Supabase's callback returns a code", async ({
  page,
}) => {
  const reports = await returnFromApple(page, { code: "an authorization code" });

  expect(reports).toEqual([]);
});

async function returnFromApple(page: Page, callbackParams: Record<string, string>) {
  await page.goto("");
  return page.evaluate(async (params) => {
    const modulePath = "/src/platform/account-auth.web.ts";
    const { signInWithApple, initializeAuthStorage } = await import(modulePath);
    const reports: unknown[] = [];
    const report = (message: string) => (error: unknown) => {
      reports.push([error instanceof Error ? error.message : error, message]);
    };
    await signInWithApple({ auth: { signInWithOAuth: async () => ({ data: {}, error: null }) } });
    const url = new URL(window.location.href);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    window.history.replaceState(null, "", url);
    await initializeAuthStorage([], report);
    await initializeAuthStorage([], report);
    return reports;
  }, callbackParams);
}
