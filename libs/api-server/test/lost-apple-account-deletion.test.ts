import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { scheduleLostAppleAccountDeletionResponseSchema } from "@cup/operator-api.routes";

import type { ApiServerEnvironment } from "#src/api-server-environment.ts";
import { createApiServer } from "#src/api-server.ts";

const ACCOUNT_ID = "d1a52e64-3e4d-4a7f-a711-7fb11501e9af";
const UNKNOWN_ACCOUNT_ID = "5b0f6a3e-8d0e-4c51-9f0e-2a8f0c6f5d11";
const SUBJECT = "f355f913-ba12-45d6-a7d2-4df95f7cf11f";
const ATTEMPT_ID = "6f1c0f0e-3f7a-4d8e-9b6a-2c1d0e9f8a7b";
const ACCOUNT_EMAIL = "abc123@privaterelay.appleid.com";
const SUPABASE_URL = "https://lost-apple-account-deletion.supabase.co";
const APPLE_ORIGIN = "https://apple.example.test";
const DEADLINE_MS = 1_800_000_000_000;

let requestedOrigins: string[];
let supabaseUser: { email?: string; identities: Array<{ provider: string }> };
let accountState: "active" | "deletion_scheduled";
const account = {
  scheduleOperatorDeletion: vi.fn<(email: string) => Promise<unknown>>(),
};

beforeEach(() => {
  vi.resetAllMocks();
  requestedOrigins = [];
  accountState = "active";
  supabaseUser = {
    email: ACCOUNT_EMAIL,
    identities: [{ provider: "apple" }],
  };
  account.scheduleOperatorDeletion.mockImplementation(async (email) => {
    if (accountState !== "active") {
      return { result: "conflict" };
    }
    accountState = "deletion_scheduled";
    return {
      result: "scheduled",
      attempt: {
        attemptId: ATTEMPT_ID,
        accountId: ACCOUNT_ID,
        subject: SUBJECT,
        email,
        scheduledAtMs: DEADLINE_MS - 7 * 86_400_000,
        deadlineMs: DEADLINE_MS,
        state: "scheduled",
        appleRevocation: "not-revoked",
      },
    };
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requestedOrigins.push(url.origin);
    if (url.origin === SUPABASE_URL && url.pathname === `/auth/v1/admin/users/${SUBJECT}`) {
      return Response.json({ id: SUBJECT, ...supabaseUser });
    }
    throw new Error(`Unexpected request to ${url.href}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function environment() {
  const env = {
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: "supabase-secret",
    APPLE_ORIGIN,
    ACCOUNTS: { idFromName: (name: string) => name, get: () => account },
    REGISTRY: {
      idFromName: (name: string) => name,
      get: () => ({
        findAccount: async (accountId: string) =>
          accountId === ACCOUNT_ID ? { accountId, subject: SUBJECT, phase: "active" } : undefined,
      }),
    },
  };
  if (!isEnvironment(env)) {
    throw new Error("Missing fixture bindings");
  }
  return env;
}

function isEnvironment(value: unknown): value is ApiServerEnvironment {
  return typeof value === "object" && value !== null && "ACCOUNTS" in value;
}

async function scheduleLostAppleAccountDeletion(
  accountId: string,
  email: string,
  { authorized = true } = {},
) {
  return createApiServer({ validateOperatorAccess: async () => authorized }).request(
    `https://cup.audio/api/operator/accounts/${accountId}/lost-apple-account-deletion`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    },
    environment(),
  );
}

test("schedules the deletion for the account's own address, records not-revoked, and never reaches Apple", async () => {
  const response = await scheduleLostAppleAccountDeletion(
    ACCOUNT_ID,
    ` ${ACCOUNT_EMAIL.toUpperCase()} `,
  );

  expect(response.status).toBe(200);
  expect(scheduleLostAppleAccountDeletionResponseSchema.parse(await response.json())).toEqual({
    accountId: ACCOUNT_ID,
    attemptId: ATTEMPT_ID,
    recoveryDeadlineMs: DEADLINE_MS,
    appleRevocation: "not-revoked",
  });
  expect(account.scheduleOperatorDeletion).toHaveBeenCalledExactlyOnceWith(ACCOUNT_EMAIL);
  expect(requestedOrigins).not.toContain(APPLE_ORIGIN);
});

test("refuses an already scheduled account", async () => {
  accountState = "deletion_scheduled";

  const response = await scheduleLostAppleAccountDeletion(ACCOUNT_ID, ACCOUNT_EMAIL);

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "account-not-active" } });
  expect(requestedOrigins).not.toContain(APPLE_ORIGIN);
});

test("refuses an unknown account without scheduling", async () => {
  const response = await scheduleLostAppleAccountDeletion(UNKNOWN_ACCOUNT_ID, ACCOUNT_EMAIL);

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "account-not-found" } });
  expect(account.scheduleOperatorDeletion).not.toHaveBeenCalled();
  expect(requestedOrigins).toStrictEqual([]);
});

test("refuses an address other than the one the account holds, without scheduling", async () => {
  const response = await scheduleLostAppleAccountDeletion(ACCOUNT_ID, "someone@example.com");

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "email-mismatch" } });
  expect(account.scheduleOperatorDeletion).not.toHaveBeenCalled();
});

test("refuses an account without an Apple identity, which confirms deletion itself", async () => {
  supabaseUser.identities = [{ provider: "google" }];

  const response = await scheduleLostAppleAccountDeletion(ACCOUNT_ID, ACCOUNT_EMAIL);

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "account-not-apple-linked" } });
  expect(account.scheduleOperatorDeletion).not.toHaveBeenCalled();
});

test("stays behind operator authentication", async () => {
  const response = await scheduleLostAppleAccountDeletion(ACCOUNT_ID, ACCOUNT_EMAIL, {
    authorized: false,
  });

  expect(response.status).toBe(401);
  expect(account.scheduleOperatorDeletion).not.toHaveBeenCalled();
  expect(requestedOrigins).toStrictEqual([]);
});
