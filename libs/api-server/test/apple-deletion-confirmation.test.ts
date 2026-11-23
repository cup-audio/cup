import { exportPKCS8, generateKeyPair, jwtVerify, SignJWT, type CryptoKey } from "jose";
import { Temporal } from "temporal-polyfill";
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
const CHALLENGE_ID = "6f1c0f0e-3f7a-4d8e-9b6a-2c1d0e9f8a7b";
const APPLE_SUBJECT = "000123.linked-apple.0456";
const REFRESH_TOKEN = "apple-refresh-token-value";
const APPLE_ORIGIN = "https://apple.example.test";
const SUPABASE_URL = "https://auth.example.test";

type AppleCall = { path: string; form: Record<string, string>; clientSecret: unknown };

let signingKeys: { privateKey: CryptoKey; publicKey: CryptoKey };
let appleCalls: AppleCall[];
let apple: { tokenStatus: number; revokeStatus: number; subject: string };
let order: string[];
const account = {
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
  mocks.authenticate.mockResolvedValue({
    result: "authenticated",
    identity: {
      subject: SUBJECT,
      email: "listener@example.com",
      providers: ["google", "apple"],
      authenticatedAtSeconds: 10,
    },
    snapshot: { state: "active" },
    account,
  });
  account.scheduleDeletion.mockImplementation(async () => {
    order.push("schedule");
    return { result: "scheduled", attempt: { attemptId: CHALLENGE_ID, deadlineMs: 100 } };
  });
  vi.stubGlobal("fetch", fakeProviders);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fakeProviders(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
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
    return Response.json({
      access_token: "apple-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: await new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer("https://appleid.apple.com")
        .setSubject(apple.subject)
        .setAudience("audio.cup.app.web")
        .sign(signingKeys.privateKey),
    });
  }
  return new Response(null, { status: apple.revokeStatus });
}

async function environment() {
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
  return env;
}

async function scheduleDeletion(body: unknown) {
  return createApiServer().request(
    "https://cup.audio/api/account/deletion",
    {
      method: "POST",
      headers: {
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

test("a Google-only deletion still schedules without reaching Apple and records no Apple revocation", async () => {
  mocks.authenticate.mockResolvedValue({
    result: "authenticated",
    identity: {
      subject: SUBJECT,
      email: "listener@example.com",
      providers: ["google"],
      authenticatedAtSeconds: 10,
    },
    snapshot: { state: "active" },
    account,
  });

  const response = await scheduleDeletion({ challengeId: CHALLENGE_ID });

  expect(response.status).toBe(200);
  expect(appleCalls).toStrictEqual([]);
  expect(account.scheduleDeletion).toHaveBeenCalledWith(
    expect.objectContaining({ appleRevocation: "unavailable" }),
  );
});
