import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { ApiServerEnvironment } from "#src/api-server-environment.ts";
import { createApiServer } from "#src/api-server.ts";

import { createAccountTokenIssuer, type AccountTokenClaims } from "#test/account-tokens.ts";

const challengeId = "d1a52e64-3e4d-4a7f-a711-7fb11501e9af";
const GOOGLE_SUBJECT = "google-subject-1";
const TEST_ACCOUNT_EMAIL = "test@cup.local";
const accountTokens = await createAccountTokenIssuer("https://account-lifecycle-api.supabase.co");

const account = {
  inspect: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  deletionChallenge: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  scheduleDeletion: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  restoreAccount: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
};
const registry = {
  findIdentity: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  provisionFromIngress: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  recordGoogleRevocation: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
};
const googleRequests = vi.fn<(url: string, form: string | undefined) => void>();
let google: { isAvailable: boolean };
let tokenClaims: AccountTokenClaims;
let accountState: string;

function environment(settings: Record<string, string> = {}) {
  const env = {
    SUPABASE_URL: accountTokens.supabaseUrl,
    SUPABASE_SECRET_KEY: "supabase-secret",
    ...settings,
    REGISTRY: { idFromName: (name: string) => name, get: () => registry },
    ACCOUNTS: { idFromName: (name: string) => name, get: () => account },
  };
  if (!isEnvironment(env)) {
    throw new Error("Invalid fixture");
  }
  return env;
}
function isEnvironment(value: unknown): value is ApiServerEnvironment {
  return typeof value === "object" && value !== null && "REGISTRY" in value;
}

const TEST_ACCOUNT_SETTINGS = {
  LOCAL_DEVELOPMENT: "true",
  LOCAL_TEST_ACCOUNT_EMAIL: TEST_ACCOUNT_EMAIL,
  LOCAL_TEST_ACCOUNT_PASSWORD: "test-password",
};
const TEST_ACCOUNT_CLAIMS: AccountTokenClaims = {
  email: TEST_ACCOUNT_EMAIL,
  provider: "email",
  providers: ["email"],
  authenticationMethod: "password",
  authenticatedAtSeconds: 10,
};

beforeEach(() => {
  vi.resetAllMocks();
  google = { isAvailable: true };
  tokenClaims = { email: "user@example.com", providers: ["google"], authenticatedAtSeconds: 10 };
  accountState = "deletion_scheduled";
  registry.findIdentity.mockResolvedValue({
    accountId: challengeId,
    subject: challengeId,
    phase: "active",
  });
  account.inspect.mockImplementation(async () => ({
    accountId: challengeId,
    subject: challengeId,
    createdAtMs: 1,
    state: accountState,
    executionEpoch: 1,
    recoveryDeadlineMs: null,
    balance: { unit: "audio-millisecond", available: 0, reserved: 0 },
  }));
  account.scheduleDeletion.mockResolvedValue({
    result: "scheduled",
    attempt: { attemptId: challengeId, deadlineMs: 100 },
  });
  account.restoreAccount.mockResolvedValue({
    result: "restored",
    account: {
      accountId: challengeId,
      subject: challengeId,
      createdAtMs: 1,
      state: "active",
      executionEpoch: 1,
      recoveryDeadlineMs: null,
      balance: { unit: "audio-millisecond", available: 0, reserved: 0 },
    },
  });
  vi.stubGlobal("fetch", fakeProviders);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fakeProviders(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const keySet = accountTokens.respondToKeySetRequest(input);
  if (keySet !== undefined) {
    return keySet;
  }
  const url = String(input instanceof Request ? input.url : input);
  if (url === `${accountTokens.supabaseUrl}/auth/v1/admin/users/${challengeId}`) {
    return Response.json({
      id: challengeId,
      identities: [{ provider: "google", identity_data: { sub: GOOGLE_SUBJECT } }],
    });
  }
  googleRequests(url, init?.body instanceof URLSearchParams ? init.body.toString() : undefined);
  if (!google.isAvailable) {
    throw new Error("Google unavailable");
  }
  if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
    return Response.json({ sub: GOOGLE_SUBJECT });
  }
  if (url === "https://oauth2.googleapis.com/revoke") {
    return new Response(null, { status: 200 });
  }
  throw new Error(`Unexpected request to ${url}`);
}

function googleRevocationRequests() {
  return googleRequests.mock.calls.filter(
    ([url]) => url === "https://oauth2.googleapis.com/revoke",
  );
}

async function request(
  path = "",
  body: unknown = { challengeId },
  headers: Record<string, string> = {},
  env = environment(),
) {
  const json = JSON.stringify(body);
  const fetchRequest = new Request(`https://cup.audio/api/account/deletion${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accountTokens.sign(challengeId, tokenClaims)}`,
      "CF-Connecting-IP": "192.0.2.1",
      "Content-Type": "application/json",
      "Content-Length": String(new TextEncoder().encode(json).byteLength),
      "X-Create-Audiobook-From-URL-Request": "1",
      ...headers,
    },
    body: json,
  });
  Object.defineProperty(fetchRequest, "cf", { value: {} });
  return createApiServer().request(fetchRequest, undefined, env);
}

test("invalid confirmation uses the shared validation error envelope", async () => {
  const response = await request("", { challengeId: "invalid" });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      code: "invalid-input",
      message: expect.any(String),
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    },
  });
  expect(account.scheduleDeletion).not.toHaveBeenCalled();
});

test.each([
  ["unauthorized", 401, () => ({ Authorization: "Bearer not-a-token" })],
  [
    "blocked",
    403,
    () => {
      registry.findIdentity.mockResolvedValue({ accountId: challengeId, phase: "deleting" });
      return {};
    },
  ],
  [
    "rate-limited",
    429,
    () => {
      registry.findIdentity.mockResolvedValue(undefined);
      registry.provisionFromIngress.mockResolvedValue({ result: "rate-limited", retryAfter: 60 });
      return {};
    },
  ],
  [
    "unavailable",
    503,
    () => {
      registry.findIdentity.mockRejectedValue(new Error("Registry unavailable"));
      return {};
    },
  ],
] as const)("preserves %s authentication errors", async (_, status, arrange) => {
  const headers = arrange();
  const response = await request("", { challengeId }, headers);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({
    error: { code: expect.any(String), traceId: expect.stringMatching(/^[0-9a-f]{32}$/) },
  });
});

test.each(["", "/restore"])(
  "distinguishes confirmation conflicts from operational failures for %s",
  async (path) => {
    const operation = path ? account.restoreAccount : account.scheduleDeletion;
    operation
      .mockResolvedValueOnce({ result: "conflict" })
      .mockRejectedValueOnce(new Error("Storage unavailable"));
    const rejected = await request(path);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: "confirmation-unavailable" } });
    const failed = await request(path);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: { code: "operational-error" } });
  },
);

test("revocation recording failure does not report invalid confirmation after scheduling", async () => {
  registry.recordGoogleRevocation.mockRejectedValue(new Error("Registry unavailable"));
  const response = await request("", {
    challengeId,
    providerCredential: { provider: "google", accessToken: "google-token" },
  });
  expect(account.scheduleDeletion).toHaveBeenCalledOnce();
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { code: "operational-error" } });
});

test("provider revocation failure is recorded without failing deletion", async () => {
  google.isAvailable = false;
  const response = await request("", {
    challengeId,
    providerCredential: { provider: "google", accessToken: "google-token" },
  });
  expect(response.status).toBe(200);
  expect(registry.recordGoogleRevocation).toHaveBeenCalledWith(challengeId, challengeId, "failed");
});

test("a Google credential is revoked after scheduling and the outcome recorded", async () => {
  const response = await request("", {
    challengeId,
    providerCredential: { provider: "google", accessToken: "google-token" },
  });
  expect(response.status).toBe(200);
  expect(googleRevocationRequests()).toHaveLength(1);
  expect(googleRevocationRequests()[0]?.[1]).toBe("token=google-token");
  expect(account.scheduleDeletion.mock.invocationCallOrder[0]).toBeLessThan(
    googleRequests.mock.invocationCallOrder[0] ?? 0,
  );
  expect(registry.recordGoogleRevocation).toHaveBeenCalledWith(challengeId, challengeId, "revoked");
});

test("the former providerToken field is ignored as an unknown key", async () => {
  const response = await request("", { challengeId, providerToken: "google-token" });
  expect(response.status).toBe(200);
  expect(account.scheduleDeletion).toHaveBeenCalledOnce();
  expect(googleRequests).not.toHaveBeenCalled();
});

test("the local test account never triggers Google token revocation", async () => {
  tokenClaims = TEST_ACCOUNT_CLAIMS;
  const response = await request(
    "",
    { challengeId, providerCredential: { provider: "google", accessToken: "google-token" } },
    {},
    environment(TEST_ACCOUNT_SETTINGS),
  );
  expect(response.status).toBe(200);
  expect(account.scheduleDeletion).toHaveBeenCalledOnce();
  expect(googleRequests).not.toHaveBeenCalled();
  expect(registry.recordGoogleRevocation).not.toHaveBeenCalled();
});

test.each(["", "/restore"])("%s requires fresh authentication", async (path) => {
  tokenClaims = { email: "user@example.com", providers: ["google"], authenticatedAtSeconds: 0 };
  const response = await request(path);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "fresh-auth-required" } });
});

test("scheduled accounts retain explicit recovery access", async () => {
  const response = await request("/restore");
  expect(response.status).toBe(200);
  expect(account.restoreAccount).toHaveBeenCalledWith(challengeId, 10);
});

test.each([
  ["active", ["google"], ["google"]],
  ["deletion_scheduled", ["google"], ["google"]],
  ["active", ["test-account"], ["test-account"]],
  ["deletion_scheduled", ["test-account"], ["test-account"]],
  ["active", ["apple"], ["apple"]],
  ["active", ["google", "apple"], ["apple"]],
  ["deletion_scheduled", ["google", "apple"], ["google", "apple"]],
])(
  "the challenge for a %s account linked to %j accepts %j",
  async (state, providers, acceptedMethods) => {
    const isTestAccount = providers.includes("test-account");
    accountState = state;
    tokenClaims = isTestAccount
      ? TEST_ACCOUNT_CLAIMS
      : { email: "user@example.com", providers, authenticatedAtSeconds: 10 };
    account.deletionChallenge.mockResolvedValue({
      challengeId,
      subject: challengeId,
      issuedAtMs: 1,
      expiresAtMs: 2,
    });
    const response = await request(
      "/challenge",
      {},
      {},
      environment(isTestAccount ? TEST_ACCOUNT_SETTINGS : {}),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      challengeId,
      subject: challengeId,
      issuedAtMs: 1,
      expiresAtMs: 2,
      acceptedMethods,
    });
  },
);

test("lifecycle requests preserve the native origin exception and reject other origins", async () => {
  expect((await request("", { challengeId }, { Origin: "https://localhost" })).status).toBe(200);
  expect((await request("", { challengeId }, { Origin: "https://example.com" })).status).toBe(403);
});
