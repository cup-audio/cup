import { exportJWK, exportPKCS8, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import type { ApiServerEnvironment } from "#src/api-server-environment.ts";
import { createApiServer } from "#src/api-server.ts";

const SUBJECT = "d1a52e64-3e4d-4a7f-a711-7fb11501e9af";
const ACCOUNT_ID = "5b0e6f3a-8c1d-4e2f-9a7b-3c4d5e6f7a8b";
const APPLE_SUBJECT = "000123.linked-apple.0456";
const REFRESH_TOKEN = "apple-refresh-token-value";
const AUTHORIZATION_CODE = "apple-authorization-code-value";
const EXCHANGED_REFRESH_TOKEN = "apple-refresh-token-from-code";
const APPLE_ORIGIN = "https://apple.example.test";
const SUPABASE_URL = "https://apple-sign-in-revocation.supabase.co";

let signingKeys: { privateKey: CryptoKey; publicKey: CryptoKey };
let appleCalls: Array<{ path: string; form: Record<string, string> }>;
let apple: { tokenStatus: number; revokeStatus: number; subject: string };
let account: { state: string; providers: string[] };

beforeAll(async () => {
  signingKeys = await generateKeyPair("ES256", { extractable: true });
});

beforeEach(() => {
  appleCalls = [];
  apple = { tokenStatus: 200, revokeStatus: 200, subject: APPLE_SUBJECT };
  account = { state: "deletion_scheduled", providers: ["google", "apple"] };
  vi.stubGlobal("fetch", fakeProviders);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fakeProviders(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.href === `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`) {
    return Response.json({ keys: [{ ...(await exportJWK(signingKeys.publicKey)), kid: "k1" }] });
  }
  if (url.href === `${SUPABASE_URL}/auth/v1/admin/users/${SUBJECT}`) {
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
      ...(init.body.get("grant_type") === "authorization_code"
        ? { refresh_token: EXCHANGED_REFRESH_TOKEN }
        : {}),
      id_token: await new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setSubject(apple.subject)
        .sign(signingKeys.privateKey),
    });
  }
  return new Response(null, { status: apple.revokeStatus });
}

async function accessToken() {
  return new SignJWT({
    role: "authenticated",
    is_anonymous: false,
    email: "listener@example.com",
    app_metadata: { provider: account.providers[0], providers: account.providers },
  })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setSubject(SUBJECT)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKeys.privateKey);
}

async function environment() {
  const env = {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: "supabase-secret",
    APPLE_ORIGIN,
    APPLE_SIGN_IN_KEY: await exportPKCS8(signingKeys.privateKey),
    APPLE_KEY_ID: "APPLEKEYID",
    APPLE_TEAM_ID: "APPLETEAM1",
    APPLE_WEB_CLIENT_ID: "audio.cup.app.web",
    APPLE_NATIVE_CLIENT_ID: "audio.cup.app",
    REGISTRY: {
      idFromName: (name: string) => name,
      get: () => ({
        findIdentity: async () => ({ accountId: ACCOUNT_ID, subject: SUBJECT, phase: "active" }),
      }),
    },
    ACCOUNTS: {
      idFromName: (name: string) => name,
      get: () => ({
        inspect: async () => ({
          accountId: ACCOUNT_ID,
          subject: SUBJECT,
          createdAtMs: 1,
          executionEpoch: 1,
          state: account.state,
          balance: { unit: "audio-millisecond", available: 0, reserved: 0 },
        }),
      }),
    },
  };
  if (!isEnvironment(env)) {
    throw new Error("Missing fixture bindings");
  }
  return env;
}

function isEnvironment(value: unknown): value is ApiServerEnvironment {
  return typeof value === "object" && value !== null && "REGISTRY" in value;
}

async function revokeAppleSignIn(
  body: unknown = { providerCredential: { provider: "apple", refreshToken: REFRESH_TOKEN } },
  headers: Record<string, string> = {},
) {
  return createApiServer().request(
    "https://cup.audio/api/account/apple-sign-in-revocation",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
        "X-Create-Audiobook-From-URL-Request": "1",
        ...headers,
      },
      body: JSON.stringify(body),
    },
    await environment(),
  );
}

async function expectSilentSuccess(response: Response) {
  expect(response.status).toBe(204);
  expect(await response.text()).toBe("");
}

test.each(["deletion_scheduled", "deleting"])(
  "an Apple sign-in into a %s account is validated and revoked at Apple",
  async (state) => {
    account.state = state;

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
  },
);

test("a native Apple sign-in into a scheduled account exchanges its authorization code as the app and revokes the refresh token", async () => {
  await expectSilentSuccess(
    await revokeAppleSignIn({
      providerCredential: { provider: "apple", authorizationCode: AUTHORIZATION_CODE },
    }),
  );

  expect(appleCalls).toStrictEqual([
    {
      path: "/auth/token",
      form: {
        client_id: "audio.cup.app",
        client_secret: expect.any(String),
        grant_type: "authorization_code",
        code: AUTHORIZATION_CODE,
      },
    },
    {
      path: "/auth/revoke",
      form: {
        client_id: "audio.cup.app",
        client_secret: expect.any(String),
        token: EXCHANGED_REFRESH_TOKEN,
        token_type_hint: "refresh_token",
      },
    },
  ]);
});

test("an Apple sign-in into an active account is left alone", async () => {
  account.state = "active";

  await expectSilentSuccess(await revokeAppleSignIn());

  expect(appleCalls).toStrictEqual([]);
});

test("a scheduled account without an Apple identity never reaches Apple", async () => {
  account.providers = ["google"];

  await expectSilentSuccess(await revokeAppleSignIn());

  expect(appleCalls).toStrictEqual([]);
});

test("a refresh token of another Apple Account is validated but not revoked", async () => {
  apple.subject = "000999.other-apple.0789";

  await expectSilentSuccess(await revokeAppleSignIn());

  expect(appleCalls.map(({ path }) => path)).toStrictEqual(["/auth/token"]);
});

test.each([
  ["validation", { tokenStatus: 400 }, ["/auth/token"]],
  ["revocation", { revokeStatus: 503 }, ["/auth/token", "/auth/revoke"]],
])("a failed Apple %s answers the same success", async (_, failure, calls) => {
  Object.assign(apple, failure);

  await expectSilentSuccess(await revokeAppleSignIn());

  expect(appleCalls.map(({ path }) => path)).toStrictEqual(calls);
});

test("a credential other than Apple's is refused as invalid input", async () => {
  const response = await revokeAppleSignIn({
    providerCredential: { provider: "google", accessToken: "token" },
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid-input" } });
  expect(appleCalls).toStrictEqual([]);
});

test("the route requires a bearer session", async () => {
  const response = await revokeAppleSignIn(undefined, { Authorization: "" });

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
  expect(appleCalls).toStrictEqual([]);
});

test("the native app's origin is admitted", async () => {
  await expectSilentSuccess(await revokeAppleSignIn(undefined, { Origin: "https://localhost" }));

  expect(appleCalls.map(({ path }) => path)).toStrictEqual(["/auth/token", "/auth/revoke"]);
});
