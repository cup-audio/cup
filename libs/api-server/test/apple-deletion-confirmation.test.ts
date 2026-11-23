import { exportPKCS8, generateKeyPair, jwtVerify, SignJWT, type CryptoKey } from "jose";
import { Temporal } from "temporal-polyfill";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import type { ApiServerEnvironment } from "#src/api-server-environment.ts";
import { createApiServer } from "#src/api-server.ts";

import { createAccountTokenIssuer } from "#test/account-tokens.ts";
import { recordSentry, stopRecordingSentry, type SentryRecorder } from "#test/sentry-recorder.ts";

const SUBJECT = "d1a52e64-3e4d-4a7f-a711-7fb11501e9af";
const CHALLENGE_ID = "6f1c0f0e-3f7a-4d8e-9b6a-2c1d0e9f8a7b";
const APPLE_SUBJECT = "000123.linked-apple.0456";
const REFRESH_TOKEN = "apple-refresh-token-value";
const AUTHORIZATION_CODE = "apple-authorization-code-value";
const EXCHANGED_REFRESH_TOKEN = "apple-refresh-token-from-code";
const APPLE_ORIGIN = "https://apple.example.test";
const accountTokens = await createAccountTokenIssuer(
  "https://apple-deletion-confirmation.supabase.co",
);
const SUPABASE_URL = accountTokens.supabaseUrl;

type AppleCall = { path: string; form: Record<string, string>; clientSecret: unknown };

let signingKeys: { privateKey: CryptoKey; publicKey: CryptoKey };
let appleCalls: AppleCall[];
let apple: { tokenStatus: number; revokeStatus: number; subject: string };
let order: string[];
let providers: string[];
let sentry: SentryRecorder;
const account = {
  inspect: async () => ({
    accountId: SUBJECT,
    subject: SUBJECT,
    createdAtMs: 1,
    executionEpoch: 1,
    state: "active",
    balance: { unit: "audio-millisecond", available: 0, reserved: 0 },
  }),
  scheduleDeletion: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
};

beforeAll(async () => {
  signingKeys = await generateKeyPair("ES256", { extractable: true });
});

beforeEach(async () => {
  vi.resetAllMocks();
  appleCalls = [];
  order = [];
  apple = { tokenStatus: 200, revokeStatus: 200, subject: APPLE_SUBJECT };
  providers = ["google", "apple"];
  sentry = recordSentry();
  account.scheduleDeletion.mockImplementation(async () => {
    order.push("schedule");
    return { result: "scheduled", attempt: { attemptId: CHALLENGE_ID, deadlineMs: 100 } };
  });
  vi.stubGlobal("fetch", fakeProviders);
});

afterEach(() => {
  vi.unstubAllGlobals();
  stopRecordingSentry();
});

async function fakeProviders(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const keySet = accountTokens.respondToKeySetRequest(input);
  if (keySet !== undefined) {
    return keySet;
  }
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === SUPABASE_URL && url.pathname === `/auth/v1/admin/users/${SUBJECT}`) {
    return Response.json({
      id: SUBJECT,
      identities: [
        { provider: "google", identity_data: { sub: "google-subject" } },
        { provider: "apple", identity_data: { sub: APPLE_SUBJECT } },
      ],
    });
  }
  if (url.origin !== APPLE_ORIGIN) {
    throw new Error(`Unexpected request to ${url.href}`);
  }
  if (!(init?.body instanceof URLSearchParams)) {
    throw new Error(`Expected a form body for ${url.href}`);
  }
  const form = Object.fromEntries(init.body);
  const clientSecret = await jwtVerify(form["client_secret"] ?? "", signingKeys.publicKey).then(
    ({ payload, protectedHeader }) => ({ header: protectedHeader, claims: payload }),
    () => "invalid",
  );
  appleCalls.push({ path: url.pathname, form, clientSecret });
  order.push(url.pathname);
  if (url.pathname === "/auth/token") {
    if (apple.tokenStatus !== 200) {
      return Response.json({ error: "invalid_grant" }, { status: apple.tokenStatus });
    }
    const isCodeExchange = form["grant_type"] === "authorization_code";
    return Response.json({
      access_token: "apple-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      ...(isCodeExchange ? { refresh_token: EXCHANGED_REFRESH_TOKEN } : {}),
      id_token: await new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer("https://appleid.apple.com")
        .setSubject(apple.subject)
        .setAudience(isCodeExchange ? "audio.cup.app" : "audio.cup.app.web")
        .sign(signingKeys.privateKey),
    });
  }
  return new Response(null, { status: apple.revokeStatus });
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
        findIdentity: async () => ({ accountId: SUBJECT, subject: SUBJECT, phase: "active" }),
      }),
    },
    ACCOUNTS: { idFromName: (name: string) => name, get: () => account },
  };
  if (!isEnvironment(env)) {
    throw new Error("Missing fixture bindings");
  }
  return env;
}

function isEnvironment(value: unknown): value is ApiServerEnvironment {
  return typeof value === "object" && value !== null && "REGISTRY" in value;
}

async function scheduleDeletion(body: unknown) {
  return createApiServer().request(
    "https://cup.audio/api/account/deletion",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accountTokens.sign(SUBJECT, { providers, authenticatedAtSeconds: 10 })}`,
        "Content-Type": "application/json",
        "X-Create-Audiobook-From-URL-Request": "1",
      },
      body: JSON.stringify(body),
    },
    await environment(),
  );
}

const appleCredential = { provider: "apple", refreshToken: REFRESH_TOKEN };

test("an Apple-linked deletion validates the refresh token, revokes it, and only then schedules", async () => {
  const response = await scheduleDeletion({
    challengeId: CHALLENGE_ID,
    providerCredential: appleCredential,
  });

  expect(response.status).toBe(200);
  expect(order).toStrictEqual(["/auth/token", "/auth/revoke", "schedule"]);
  const nowSeconds = Math.floor(Temporal.Now.instant().epochMilliseconds / 1000);
  const clientSecret = {
    header: { alg: "ES256", kid: "APPLEKEYID" },
    claims: {
      iss: "APPLETEAM1",
      aud: "https://appleid.apple.com",
      sub: "audio.cup.app.web",
      iat: expect.toBeOneOf([nowSeconds, nowSeconds - 1]),
      exp: expect.toSatisfy((exp: number) => exp > nowSeconds && exp <= nowSeconds + 300),
    },
  };
  expect(appleCalls).toStrictEqual([
    {
      path: "/auth/token",
      form: {
        client_id: "audio.cup.app.web",
        client_secret: expect.any(String),
        grant_type: "refresh_token",
        refresh_token: REFRESH_TOKEN,
      },
      clientSecret,
    },
    {
      path: "/auth/revoke",
      form: {
        client_id: "audio.cup.app.web",
        client_secret: expect.any(String),
        token: REFRESH_TOKEN,
        token_type_hint: "refresh_token",
      },
      clientSecret,
    },
  ]);
  expect(account.scheduleDeletion).toHaveBeenCalledWith({
    challengeId: CHALLENGE_ID,
    authenticatedAtSeconds: 10,
    email: "listener@example.com",
    appleRevocation: "revoked",
  });
});

const nativeAppleCredential = { provider: "apple", authorizationCode: AUTHORIZATION_CODE };

test("a native Apple deletion exchanges the authorization code as the app, revokes the refresh token, and only then schedules", async () => {
  const response = await scheduleDeletion({
    challengeId: CHALLENGE_ID,
    providerCredential: nativeAppleCredential,
  });

  expect(response.status).toBe(200);
  expect(order).toStrictEqual(["/auth/token", "/auth/revoke", "schedule"]);
  const nowSeconds = Math.floor(Temporal.Now.instant().epochMilliseconds / 1000);
  const clientSecret = {
    header: { alg: "ES256", kid: "APPLEKEYID" },
    claims: {
      iss: "APPLETEAM1",
      aud: "https://appleid.apple.com",
      sub: "audio.cup.app",
      iat: expect.toBeOneOf([nowSeconds, nowSeconds - 1]),
      exp: expect.toSatisfy((exp: number) => exp > nowSeconds && exp <= nowSeconds + 300),
    },
  };
  expect(appleCalls).toStrictEqual([
    {
      path: "/auth/token",
      form: {
        client_id: "audio.cup.app",
        client_secret: expect.any(String),
        grant_type: "authorization_code",
        code: AUTHORIZATION_CODE,
      },
      clientSecret,
    },
    {
      path: "/auth/revoke",
      form: {
        client_id: "audio.cup.app",
        client_secret: expect.any(String),
        token: EXCHANGED_REFRESH_TOKEN,
        token_type_hint: "refresh_token",
      },
      clientSecret,
    },
  ]);
  expect(account.scheduleDeletion).toHaveBeenCalledWith(
    expect.objectContaining({ appleRevocation: "revoked" }),
  );
});

test("an authorization code of another Apple Account is refused without revoking or scheduling", async () => {
  apple.subject = "000999.other-apple.0789";

  const response = await scheduleDeletion({
    challengeId: CHALLENGE_ID,
    providerCredential: nativeAppleCredential,
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "apple-account-mismatch" } });
  expect(order).toStrictEqual(["/auth/token"]);
  expect(account.scheduleDeletion).not.toHaveBeenCalled();
});

test("an expired or reused authorization code answers Apple's retryable failure, schedules nothing, and logs no code", async () => {
  apple.tokenStatus = 400;

  const response = await scheduleDeletion({
    challengeId: CHALLENGE_ID,
    providerCredential: nativeAppleCredential,
  });

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "apple-confirmation-failed" } });
  expect(order).toStrictEqual(["/auth/token"]);
  expect(account.scheduleDeletion).not.toHaveBeenCalled();
  expect(sentry.exceptions).toHaveLength(1);
  const logged = JSON.stringify(
    sentry.exceptions.map((error) =>
      error instanceof Error ? { message: error.message, cause: String(error.cause) } : error,
    ),
  );
  expect(logged).not.toContain(AUTHORIZATION_CODE);
  expect(logged).not.toContain("invalid_grant");
});

test.each([
  ["no credential", {}],
  ["a Google credential", { providerCredential: { provider: "google", accessToken: "token" } }],
])("an Apple-linked deletion with %s is refused before reaching Apple", async (_, input) => {
  const response = await scheduleDeletion({ challengeId: CHALLENGE_ID, ...input });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "fresh-auth-required" } });
  expect(appleCalls).toStrictEqual([]);
  expect(account.scheduleDeletion).not.toHaveBeenCalled();
});

test("a refresh token of another Apple Account is refused without revoking or scheduling", async () => {
  apple.subject = "000999.other-apple.0789";

  const response = await scheduleDeletion({
    challengeId: CHALLENGE_ID,
    providerCredential: appleCredential,
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "apple-account-mismatch" } });
  expect(order).toStrictEqual(["/auth/token"]);
  expect(account.scheduleDeletion).not.toHaveBeenCalled();
});

test.each([
  ["validation", { tokenStatus: 400 }, ["/auth/token"]],
  ["revocation", { revokeStatus: 503 }, ["/auth/token", "/auth/revoke"]],
])(
  "a failed Apple %s schedules nothing, answers a retryable error, and logs no token",
  async (_, failure, calls) => {
    Object.assign(apple, failure);

    const response = await scheduleDeletion({
      challengeId: CHALLENGE_ID,
      providerCredential: appleCredential,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "apple-confirmation-failed" } });
    expect(order).toStrictEqual(calls);
    expect(account.scheduleDeletion).not.toHaveBeenCalled();
    expect(sentry.exceptions).toHaveLength(1);
    const logged = JSON.stringify(
      sentry.exceptions.map((error) =>
        error instanceof Error ? { message: error.message, cause: String(error.cause) } : error,
      ),
    );
    expect(logged).not.toContain(REFRESH_TOKEN);
    expect(logged).not.toContain("invalid_grant");
  },
);

test("a Google-only deletion still schedules without reaching Apple and records no Apple revocation", async () => {
  providers = ["google"];

  const response = await scheduleDeletion({ challengeId: CHALLENGE_ID });

  expect(response.status).toBe(200);
  expect(appleCalls).toStrictEqual([]);
  expect(account.scheduleDeletion).toHaveBeenCalledWith(
    expect.objectContaining({ appleRevocation: "unavailable" }),
  );
});
