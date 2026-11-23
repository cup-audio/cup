import { exportPKCS8, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import type { ApiServerEnvironment } from "#src/api-server-environment.ts";
import { createApiServer } from "#src/api-server.ts";

vi.mock("@cup/conversion-grants", async () => ({
  ...(await import("@cup/conversion-grants/contracts")),
  clearGrantSessionCookie: () => "",
  createGrantSessionCookie: () => "",
  createRootCredential: () => "",
  getGrantSessionCookie: () => undefined,
}));
const mocks = vi.hoisted(() => ({
  authenticate: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  captureException: vi.fn<(...args: unknown[]) => void>(),
}));
vi.mock("#src/http/account-auth.ts", async (original) => ({
  ...(await original<typeof import("#src/http/account-auth.ts")>()),
  authenticateAccountRequest: mocks.authenticate,
}));
vi.mock("@sentry/core", async (original) => ({
  ...(await original<typeof import("@sentry/core")>()),
  captureException: mocks.captureException,
}));

const SUBJECT = "d1a52e64-3e4d-4a7f-a711-7fb11501e9af";
const APPLE_SUBJECT = "000123.linked-apple.0456";
const REFRESH_TOKEN = "apple-refresh-token-value";
const APPLE_ORIGIN = "https://apple.example.test";
const SUPABASE_URL = "https://auth.example.test";

let signingKeys: { privateKey: CryptoKey; publicKey: CryptoKey };
let appleCalls: Array<{ path: string; form: Record<string, string> }>;
let apple: { tokenStatus: number; revokeStatus: number; subject: string };

beforeAll(async () => {
  signingKeys = await generateKeyPair("ES256", { extractable: true });
});

beforeEach(() => {
  vi.resetAllMocks();
  appleCalls = [];
  apple = { tokenStatus: 200, revokeStatus: 200, subject: APPLE_SUBJECT };
  authenticateAs("deletion_scheduled", ["google", "apple"]);
  vi.stubGlobal("fetch", fakeProviders);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function authenticateAs(state: string, providers: string[]) {
  mocks.authenticate.mockResolvedValue({
    result: "authenticated",
    identity: {
      subject: SUBJECT,
      email: "listener@example.com",
      providers,
      authenticatedAtSeconds: 10,
    },
    snapshot: { state },
    account: {},
  });
}

async function fakeProviders(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === SUPABASE_URL && url.pathname === `/auth/v1/admin/users/${SUBJECT}`) {
    return Response.json({
      id: SUBJECT,
      identities: [{ provider: "apple", identity_data: { sub: APPLE_SUBJECT } }],
    });
  }
  if (url.origin !== APPLE_ORIGIN || !(init?.body instanceof URLSearchParams)) {
    throw new Error(`Unexpected request to ${url.href}`);
  }
  appleCalls.push({ path: url.pathname, form: Object.fromEntries(init.body) });
  if (url.pathname === "/auth/token") {
    if (apple.tokenStatus !== 200) {
      return Response.json({ error: "invalid_grant" }, { status: apple.tokenStatus });
    }
    return Response.json({
      id_token: await new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setSubject(apple.subject)
        .sign(signingKeys.privateKey),
    });
  }
  return new Response(null, { status: apple.revokeStatus });
}

async function revokeAppleSignIn(
  body: unknown = { providerCredential: { provider: "apple", refreshToken: REFRESH_TOKEN } },
  headers: Record<string, string> = {},
) {
  const env: Partial<ApiServerEnvironment> = {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: "supabase-secret",
    APPLE_ORIGIN,
    APPLE_SIGN_IN_KEY: await exportPKCS8(signingKeys.privateKey),
    APPLE_KEY_ID: "APPLEKEYID",
    APPLE_TEAM_ID: "APPLETEAM1",
    APPLE_WEB_CLIENT_ID: "audio.cup.app.web",
    APPLE_NATIVE_CLIENT_ID: "audio.cup.app",
  };
  return createApiServer().request(
    "https://cup.audio/api/account/apple-sign-in-revocation",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Create-Audiobook-From-URL-Request": "1",
        ...headers,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function expectSilentSuccess(response: Response) {
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
}

test.each(["deletion_scheduled", "deleting"])(
  "an Apple sign-in into a %s account is validated and revoked at Apple",
  async (state) => {
    authenticateAs(state, ["google", "apple"]);

    await expectSilentSuccess(await revokeAppleSignIn());

    expect(appleCalls).toStrictEqual([
      {
        path: "/auth/token",
        form: {
          client_id: "audio.cup.app.web",
          client_secret: expect.any(String),
          grant_type: "refresh_token",
          refresh_token: REFRESH_TOKEN,
        },
      },
      {
        path: "/auth/revoke",
        form: {
          client_id: "audio.cup.app.web",
          client_secret: expect.any(String),
          token: REFRESH_TOKEN,
          token_type_hint: "refresh_token",
        },
      },
    ]);
    expect(mocks.captureException).not.toHaveBeenCalled();
  },
);

test("an Apple sign-in into an active account is left alone", async () => {
  authenticateAs("active", ["apple"]);

  await expectSilentSuccess(await revokeAppleSignIn());

  expect(appleCalls).toStrictEqual([]);
});

test("a scheduled account without an Apple identity never reaches Apple", async () => {
  authenticateAs("deletion_scheduled", ["google"]);

  await expectSilentSuccess(await revokeAppleSignIn());

  expect(appleCalls).toStrictEqual([]);
  expect(mocks.captureException).not.toHaveBeenCalled();
});

test("a refresh token of another Apple Account is validated but not revoked", async () => {
  apple.subject = "000999.other-apple.0789";

  await expectSilentSuccess(await revokeAppleSignIn());

  expect(appleCalls.map(({ path }) => path)).toStrictEqual(["/auth/token"]);
});

test.each([
  ["validation", { tokenStatus: 400 }],
  ["revocation", { revokeStatus: 503 }],
])(
  "a failed Apple %s answers the same success and is logged without the token",
  async (_, failure) => {
    Object.assign(apple, failure);

    await expectSilentSuccess(await revokeAppleSignIn());

    expect(mocks.captureException).toHaveBeenCalledOnce();
    const logged = JSON.stringify(
      mocks.captureException.mock.calls.map(([error]) =>
        error instanceof Error ? { message: error.message, cause: String(error.cause) } : error,
      ),
    );
    expect(logged).not.toContain(REFRESH_TOKEN);
    expect(logged).not.toContain("invalid_grant");
  },
);

test("a credential other than Apple's is refused as invalid input", async () => {
  const response = await revokeAppleSignIn({
    providerCredential: { provider: "google", accessToken: "token" },
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid-input" } });
  expect(appleCalls).toStrictEqual([]);
});

test("the route requires a bearer session", async () => {
  mocks.authenticate.mockResolvedValue({ result: "unauthorized" });

  const response = await revokeAppleSignIn();

  expect(response.status).toBe(401);
  expect(appleCalls).toStrictEqual([]);
});

test.each([
  ["a foreign origin", { Origin: "https://example.com" }],
  ["a non-JSON content type", { "Content-Type": "text/plain" }],
  ["no Cup request header", { "X-Create-Audiobook-From-URL-Request": "0" }],
])("a request with %s is blocked before reaching Apple", async (_, headers) => {
  const response = await revokeAppleSignIn(undefined, headers);

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "origin-blocked" } });
  expect(mocks.authenticate).not.toHaveBeenCalled();
  expect(appleCalls).toStrictEqual([]);
});

test("the native app's origin is admitted", async () => {
  await expectSilentSuccess(await revokeAppleSignIn(undefined, { Origin: "https://localhost" }));

  expect(appleCalls.map(({ path }) => path)).toStrictEqual(["/auth/token", "/auth/revoke"]);
});
