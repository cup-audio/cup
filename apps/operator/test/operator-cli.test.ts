import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { Temporal } from "temporal-polyfill";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

import { LOCAL_OPERATOR_ACCESS_TOKEN } from "@cup/operator-api.routes";

const GRANT_ID = "b4ad28a8-bbd7-46af-a17c-59527becd745";
const REQUEST_ID = "2f94d6a9-68eb-49eb-b88e-753cf5fba041";
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const ACCOUNT_ID = "d1a52e64-3e4d-4a7f-a711-7fb11501e9af";
const PROJECTED_ACCOUNT_ID = "e2b63f75-4f5e-4b8a-b822-8ac22612fab0";
const SUBJECT = "6c1f9e4a-2b7d-4e8f-9a3c-5d6e7f8a9b0c";
const CREATED_AT = "2026-08-28T10:00:00Z";
const EXPIRES_AT = "2026-11-26T10:00:00Z";
const root = path.resolve(import.meta.dirname, "../../..");
const cliPath = path.join(root, "apps/operator/src/cli.ts");
const CONVERSION_ID = "f9cc2e59-46a3-4890-b923-bda04d03b4d0";
const DELETED_CONVERSION_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const PENDING_CONVERSION_ID = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
const adjustmentBodies: unknown[] = [];
const conversionDeletionPaths: string[] = [];
const ledgerQueries: string[] = [];
const lostAppleAccountDeletionBodies: unknown[] = [];
const SCHEDULED_ACCOUNT_ID = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const ATTEMPT_ID = "9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const RELAY_EMAIL = "abc123@privaterelay.appleid.com";
const RECOVERY_DEADLINE_MS = Temporal.Instant.from("2026-11-30T10:00:00Z").epochMilliseconds;
let server: http.Server;
let operatorUrl: string;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("No test server address.");
  }
  operatorUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(
  async () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
);

describe("actual operator CLI process", () => {
  test("shows command help", async () => {
    const result = await runCli("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Manage conversion grants");
  });

  test("rejects HTTP for a Tailnet operator URL", async () => {
    const result = await runCliAt(
      "http://macbook-pro-pkerschbaum.oberhasli-universe.ts.net:5173",
      "grant",
      "list",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The operator URL must use HTTPS.");
  });

  test.each([
    ["create", ["grant", "create", "--label", "Evaluation", "--request-id", REQUEST_ID]],
    ["list", ["grant", "list"]],
    ["inspect", ["grant", "inspect", GRANT_ID]],
    ["revoke", ["grant", "revoke", GRANT_ID, "--yes"]],
    ["invalidate", ["grant", "invalidate-sessions", GRANT_ID, "--reason", "Emergency", "--yes"]],
  ])("runs %s in JSON mode without leaking authorization", async (_name, arguments_) => {
    const result = await runCli("--json", ...arguments_);
    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout) as unknown).not.toThrow();
    expect(`${result.stdout}${result.stderr}`).not.toContain("local-access-token");
    expect(`${result.stdout}${result.stderr}`).not.toContain("Cf-Access-Token");
  });

  test("lists account deletions with each attempt's Google and Apple revocation", async () => {
    const result = await runCli("--json", "account", "deletions");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout) as unknown).toEqual(deletionsFixture());

    const human = await runCli("account", "deletions");
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('"googleRevocation": "unavailable"');
    expect(human.stdout).toContain('"appleRevocation": "not-revoked"');
  });

  test("refuses to schedule a lost-Apple-Account deletion without --yes before contacting the API", async () => {
    lostAppleAccountDeletionBodies.length = 0;
    const result = await runCli(
      "account",
      "delete-lost-apple-account",
      ACCOUNT_ID,
      "--email",
      RELAY_EMAIL,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("required option '--yes' not specified");
    expect(lostAppleAccountDeletionBodies).toEqual([]);
  });

  test("schedules a lost-Apple-Account deletion for the confirmed address and shows that Apple was not revoked", async () => {
    lostAppleAccountDeletionBodies.length = 0;
    const result = await runCli(
      "account",
      "delete-lost-apple-account",
      ACCOUNT_ID,
      "--email",
      RELAY_EMAIL,
      "--yes",
    );
    expect(result.status).toBe(0);
    expect(lostAppleAccountDeletionBodies).toEqual([{ email: RELAY_EMAIL }]);
    expect(result.stdout).toContain(`Account ID: ${ACCOUNT_ID}`);
    expect(result.stdout).toContain(`Attempt ID: ${ATTEMPT_ID}`);
    expect(result.stdout).toContain("Recovery deadline: 2026-11-30T10:00:00Z");
    expect(result.stdout).toContain("Apple revocation: not-revoked");
  });

  test("reports the refusal of an already scheduled account", async () => {
    const result = await runCli(
      "--json",
      "account",
      "delete-lost-apple-account",
      SCHEDULED_ACCOUNT_ID,
      "--email",
      RELAY_EMAIL,
      "--yes",
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr) as unknown).toEqual({
      error: {
        code: "account-not-active",
        message: "The account is already scheduled for deletion or being deleted.",
        traceId: TRACE_ID,
      },
    });
  });

  test("lists accounts with a phase filter and next cursor", async () => {
    const result = await runCli("account", "list", "--phase", "deleting_identity");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Account ID: ${ACCOUNT_ID}`);
    expect(result.stdout).toContain("Phase: deleting_identity");
    expect(result.stdout).toContain("Usage: not yet projected");
    expect(result.stdout).toContain(`Account ID: ${PROJECTED_ACCOUNT_ID}`);
    expect(result.stdout).toContain("Allowance minutes: 30");
    expect(result.stdout).toContain("Spent minutes: 12.5");
    expect(result.stdout).toContain("Reserved minutes: 2");
    expect(result.stdout).toContain("Available minutes: 15.5");
    expect(result.stdout).toContain("Next cursor: next");
  });

  test("adjusts an account allowance with a signed amount and a reusable request ID", async () => {
    adjustmentBodies.length = 0;
    const result = await runCli(
      "--json",
      "account",
      "adjust-allowance",
      ACCOUNT_ID,
      "--minutes=-1.5",
      "--reason",
      "Correction",
      "--request-id",
      REQUEST_ID,
    );
    expect(result.status).toBe(0);
    expect(adjustmentBodies).toEqual([
      { requestId: REQUEST_ID, amountMilliseconds: -90_000, reason: "Correction" },
    ]);
    expect(JSON.parse(result.stdout) as unknown).toEqual({
      requestId: REQUEST_ID,
      accountId: ACCOUNT_ID,
      balance: { unit: "audio-millisecond", available: 3_600_000, reserved: 0 },
    });
  });

  test("generates a request ID when none is given", async () => {
    adjustmentBodies.length = 0;
    const result = await runCli(
      "--json",
      "account",
      "adjust-allowance",
      ACCOUNT_ID,
      "--minutes",
      "30",
      "--reason",
      "Goodwill",
    );
    expect(result.status).toBe(0);
    const withRequestId = z.looseObject({ requestId: z.uuid() });
    const body = withRequestId.parse(adjustmentBodies[0]);
    expect(body).toMatchObject({ amountMilliseconds: 1_800_000, reason: "Goodwill" });
    expect(withRequestId.parse(JSON.parse(result.stdout)).requestId).toBe(body.requestId);
  });

  test("rejects a zero allowance adjustment before contacting the API", async () => {
    adjustmentBodies.length = 0;
    const result = await runCli(
      "account",
      "adjust-allowance",
      ACCOUNT_ID,
      "--minutes",
      "0",
      "--reason",
      "None",
    );
    expect(result.status).not.toBe(0);
    expect(adjustmentBodies).toEqual([]);
  });

  test("refuses to delete a conversion without --yes before contacting the API", async () => {
    conversionDeletionPaths.length = 0;
    const result = await runCli("conversion", "delete", CONVERSION_ID);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("required option '--yes' not specified");
    expect(conversionDeletionPaths).toEqual([]);
  });

  test("deletes a conversion and names it, its owning account, and where to follow cleanup", async () => {
    conversionDeletionPaths.length = 0;
    const result = await runCli("conversion", "delete", CONVERSION_ID, "--yes");
    expect(result.status).toBe(0);
    expect(conversionDeletionPaths).toEqual([`/api/operator/conversions/${CONVERSION_ID}`]);
    expect(result.stdout).toContain(`Conversion ID: ${CONVERSION_ID}`);
    expect(result.stdout).toContain(`Account ID: ${ACCOUNT_ID}`);
    expect(result.stdout).toContain(`account inspect ${ACCOUNT_ID}`);
  });

  test("deletes a conversion in JSON mode", async () => {
    const result = await runCli("--json", "conversion", "delete", CONVERSION_ID, "--yes");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout) as unknown).toEqual({
      conversionId: CONVERSION_ID,
      accountId: ACCOUNT_ID,
    });
  });

  test("shows each conversion deletion of an account with its marker time and age", async () => {
    const result = await runCli("account", "inspect", ACCOUNT_ID);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Conversion deletions:");
    expect(result.stdout).toContain(`Conversion ID: ${DELETED_CONVERSION_ID}`);
    expect(result.stdout).toMatch(/Deleting since \(epoch ms\): \d+/);
    expect(result.stdout).toContain("Age (minutes): 90");
  });

  test("shows the narration language of each conversion in an account's history, and none without one", async () => {
    const result = await runCli("account", "inspect", ACCOUNT_ID);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      [
        "Narration languages:",
        `Conversion ID: ${CONVERSION_ID}`,
        "Narration language: de-AT",
        "",
        `Conversion ID: ${PENDING_CONVERSION_ID}`,
        "Narration language: none",
        "",
      ].join("\n"),
    );
  });

  test("pages an account's ledger and totals each conversion's segments, spent and released duration", async () => {
    ledgerQueries.length = 0;
    const result = await runCli(
      "account",
      "ledger",
      ACCOUNT_ID,
      "--limit",
      "1000",
      "--cursor",
      "7",
    );
    expect(result.status).toBe(0);
    expect(ledgerQueries).toEqual(["?limit=1000&cursor=7"]);
    expect(result.stdout).toContain(
      [
        "2026-11-18T10:00:00.000Z grant 1800000 ms (available +1800000, reserved +0) welcome-v1",
        `2026-11-18T10:01:00.000Z reserve 7000 ms (available -7000, reserved +7000) ${CONVERSION_ID}`,
      ].join("\n"),
    );
    expect(result.stdout).toContain(
      [
        "Conversions on this page:",
        `Conversion ID: ${CONVERSION_ID}`,
        "First event: 2026-11-18T10:01:00.000Z",
        "Last event: 2026-11-18T10:03:00.000Z",
        "Segments: 2",
        "Spent minutes: 0.1",
        "Released minutes: 0.11666666666666667",
        "",
        `Conversion ID: ${DELETED_CONVERSION_ID}`,
        "First event: 2026-11-18T10:04:00.000Z",
        "Last event: 2026-11-18T10:05:00.000Z",
        "Segments: 1",
        "Spent minutes: 1",
        "Released minutes: 0",
        "",
        "Next cursor: 12",
      ].join("\n"),
    );
  });

  test("writes an account's ledger page as JSON and rejects a limit above 1000", async () => {
    const result = await runCli("--json", "account", "ledger", ACCOUNT_ID);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout) as unknown).toEqual(ledgerFixture());
    const refused = await runCli("account", "ledger", ACCOUNT_ID, "--limit", "1001");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--limit must be an integer from 1 through 1000.");
  });

  test("reports API refusals with the API error code, message and trace ID", async () => {
    const result = await runCli("--json", "account", "inspect", GRANT_ID);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr) as unknown).toEqual({
      error: { code: "account-unavailable", message: "Account unavailable.", traceId: TRACE_ID },
    });
  });

  test("shows an API refusal's trace ID in human output", async () => {
    const result = await runCli("account", "inspect", GRANT_ID);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`Error: Account unavailable.\nTrace ID: ${TRACE_ID}\n`);
  });

  test("reports network failures as a generic operator error", async () => {
    const result = await runCliAt("http://127.0.0.1:1", "--json", "grant", "list");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr) as unknown).toEqual({
      error: { code: "operator-error", message: "The operator request failed." },
    });
  });

  test("labels projected and authoritative human output", async () => {
    expect((await runCli("grant", "list")).stdout).toContain("State (projected)");
    expect((await runCli("grant", "inspect", GRANT_ID)).stdout).toContain("State (authoritative)");
  });

  test("prints a complete partial migration report and exits one", async () => {
    const result = await runCli("--json", "grant", "migrate", "--yes");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout) as unknown).toEqual({
      complete: false,
      registryVersion: 1,
      grants: [{ grantId: GRANT_ID, success: false, error: "Migration failed." }],
    });
  });
});

function runCli(
  ...arguments_: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return runCliAt(operatorUrl, ...arguments_);
}

function runCliAt(
  targetOperatorUrl: string,
  ...arguments_: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, "--operator-url", targetOperatorUrl, ...arguments_],
      {
        cwd: root,
        env: { ...process.env, CREATE_AUDIOBOOK_FROM_URL_ACCESS_TOKEN: undefined },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
  const url = new URL(request.url ?? "/", operatorUrl);
  if (request.headers["cf-access-token"] !== LOCAL_OPERATOR_ACCESS_TOKEN) {
    return send(response, 401, {
      error: { code: "operator-unauthorized", message: "Local authorization required." },
    });
  }
  const body = await readBody(request);
  if (body !== "" && request.headers["content-type"] !== "application/json") {
    return send(response, 415, {
      error: { code: "unsupported-media-type", message: "JSON required." },
    });
  }
  if (handleAccountRequest(request.method, url, body, response)) {
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/operator/grants") {
    return send(response, 201, {
      result: "issued",
      grantId: GRANT_ID,
      requestId: REQUEST_ID,
      label: "Evaluation",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      state: "open",
      trialLink: `${operatorUrl}/app/trials/${GRANT_ID}#credential=v1.${"a".repeat(43)}`,
    });
  }
  if (request.method === "GET" && url.pathname === "/api/operator/grants") {
    return send(response, 200, {
      grants: [
        {
          grantId: GRANT_ID,
          requestId: REQUEST_ID,
          label: "Evaluation",
          createdAt: CREATED_AT,
          expiresAt: EXPIRES_AT,
          state: "open",
        },
      ],
    });
  }
  if (request.method === "GET" && url.pathname === `/api/operator/grants/${GRANT_ID}`) {
    return send(response, 200, inspectFixture());
  }
  if (request.method === "POST" && url.pathname.endsWith("/revocation")) {
    return send(response, 200, { changed: true, grant: grantFixture("revoked") });
  }
  if (request.method === "POST" && url.pathname.endsWith("/session-invalidations")) {
    return send(response, 200, { invalidatedAt: CREATED_AT, grant: grantFixture("revoked") });
  }
  if (request.method === "POST" && url.pathname === "/api/operator/grant-migrations") {
    return send(response, 200, {
      complete: false,
      registryVersion: 1,
      grants: [{ grantId: GRANT_ID, success: false, error: "Migration failed." }],
    });
  }
  return send(response, 404, { error: { code: "not-found", message: "Not found." } });
}

function handleAccountRequest(
  method: string | undefined,
  url: URL,
  body: string,
  response: http.ServerResponse,
): boolean {
  if (method === "GET") {
    return handleAccountRead(url, response);
  }
  if (method === "POST") {
    return handleAccountWrite(url, body, response);
  }
  if (method === "DELETE" && url.pathname === `/api/operator/conversions/${CONVERSION_ID}`) {
    conversionDeletionPaths.push(url.pathname);
    send(response, 200, { conversionId: CONVERSION_ID, accountId: ACCOUNT_ID });
    return true;
  }
  return false;
}

function handleAccountRead(url: URL, response: http.ServerResponse): boolean {
  if (url.pathname === `/api/operator/accounts/${ACCOUNT_ID}/ledger`) {
    ledgerQueries.push(url.search);
    send(response, 200, ledgerFixture());
    return true;
  }
  if (url.pathname === "/api/operator/accounts") {
    send(response, 200, {
      accounts: [
        {
          accountId: ACCOUNT_ID,
          subject: SUBJECT,
          createdAt: CREATED_AT,
          phase: url.searchParams.get("phase") ?? "active",
        },
        {
          accountId: PROJECTED_ACCOUNT_ID,
          subject: SUBJECT,
          createdAt: CREATED_AT,
          phase: "active",
          usage: {
            allowanceMilliseconds: 1_800_000,
            reservedMilliseconds: 120_000,
            spentMilliseconds: 750_000,
            availableMilliseconds: 930_000,
          },
        },
      ],
      nextCursor: "next",
    });
  } else if (url.pathname === "/api/operator/accounts/deletions") {
    send(response, 200, deletionsFixture());
  } else if (url.pathname === `/api/operator/accounts/${ACCOUNT_ID}`) {
    send(response, 200, accountInspectionFixture());
  } else if (url.pathname === `/api/operator/accounts/${GRANT_ID}`) {
    send(response, 404, {
      error: {
        code: "account-unavailable",
        message: "Account unavailable.",
        traceId: TRACE_ID,
      },
    });
  } else {
    return false;
  }
  return true;
}

function handleAccountWrite(url: URL, body: string, response: http.ServerResponse): boolean {
  if (url.pathname === `/api/operator/accounts/${ACCOUNT_ID}/lost-apple-account-deletion`) {
    lostAppleAccountDeletionBodies.push(JSON.parse(body));
    send(response, 200, {
      accountId: ACCOUNT_ID,
      attemptId: ATTEMPT_ID,
      recoveryDeadlineMs: RECOVERY_DEADLINE_MS,
      appleRevocation: "not-revoked",
    });
    return true;
  }
  if (
    url.pathname === `/api/operator/accounts/${SCHEDULED_ACCOUNT_ID}/lost-apple-account-deletion`
  ) {
    send(response, 409, {
      error: {
        code: "account-not-active",
        message: "The account is already scheduled for deletion or being deleted.",
        traceId: TRACE_ID,
      },
    });
    return true;
  }
  if (url.pathname !== `/api/operator/accounts/${ACCOUNT_ID}/allowance-adjustments`) {
    return false;
  }
  adjustmentBodies.push(JSON.parse(body));
  send(response, 200, {
    accountId: ACCOUNT_ID,
    balance: { unit: "audio-millisecond", available: 3_600_000, reserved: 0 },
  });
  return true;
}

function deletionsFixture() {
  return {
    attempts: [
      {
        attemptId: ATTEMPT_ID,
        accountId: ACCOUNT_ID,
        state: "scheduled",
        identityDone: false,
        accountDone: false,
        failures: 0,
        overdue: false,
        googleRevocation: "unavailable",
        appleRevocation: "not-revoked",
      },
    ],
    receipts: [],
  };
}

function grantFixture(state: "open" | "revoked") {
  return {
    grantId: GRANT_ID,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    ...(state === "revoked" ? { revokedAt: CREATED_AT } : {}),
    state,
    duration: { availableMilliseconds: 5, reservedMilliseconds: 0, spentMilliseconds: 0 },
    conversions: [],
  };
}

function accountInspectionFixture() {
  const balance = { unit: "audio-millisecond", available: 1_800_000, reserved: 0 };
  return {
    account: {
      accountId: ACCOUNT_ID,
      subject: SUBJECT,
      createdAtMs: 1,
      state: "active",
      executionEpoch: 1,
      recoveryDeadlineMs: null,
      balance,
    },
    accounting: { balance, reconstructed: { available: 1_800_000, reserved: 0 }, entries: 1 },
    history: {
      items: [
        {
          conversionId: CONVERSION_ID,
          idempotencyKey: CONVERSION_ID,
          sourceUrl: "https://example.com/book",
          createdAtMs: 2,
          status: "ready",
          lastStartedPhase: "finalization",
          completedAtMs: 3,
          outcome: {
            status: "ready",
            title: "Book",
            audiobookReference: {
              key: "manifest.json",
              contentType: "application/json",
              byteLength: 12,
              etag: "etag",
            },
            narrationLanguage: "de-AT",
          },
        },
        {
          conversionId: PENDING_CONVERSION_ID,
          idempotencyKey: PENDING_CONVERSION_ID,
          sourceUrl: "https://example.com/pending",
          createdAtMs: 1,
          status: "pending",
          lastStartedPhase: "conversion-start",
          outcome: null,
          completedAtMs: null,
        },
      ],
      nextCursor: null,
    },
    writers: [],
    conversionDeletions: [
      {
        conversionId: DELETED_CONVERSION_ID,
        deletingSinceMs: Temporal.Now.instant().epochMilliseconds - 90 * 60_000 - 5_000,
      },
    ],
  };
}

function minute(value: number): number {
  return Temporal.Instant.from(`2026-11-18T10:0${value}:00Z`).epochMilliseconds;
}
function segment(conversionId: string, sequence: number): string {
  return `segment:${conversionId}:${sequence}:7a0c2f4e-0d55-4b8e-9a43-3c1a8f2b9d1${sequence}`;
}
function ledgerFixture() {
  return {
    unit: "audio-millisecond",
    entries: [
      {
        eventKind: "grant",
        operationId: `welcome:${ACCOUNT_ID}:v1`,
        amount: 1_800_000,
        availableDelta: 1_800_000,
        reservedDelta: 0,
        createdAtMs: minute(0),
        cause: "welcome-v1",
      },
      ...[0, 1].map((sequence) => ({
        eventKind: "reserve",
        operationId: segment(CONVERSION_ID, sequence),
        amount: 7_000,
        availableDelta: -7_000,
        reservedDelta: 7_000,
        createdAtMs: minute(1),
        cause: CONVERSION_ID,
      })),
      {
        eventKind: "consume",
        operationId: segment(CONVERSION_ID, 0),
        amount: 6_000,
        availableDelta: 1_000,
        reservedDelta: -7_000,
        createdAtMs: minute(2),
        cause: CONVERSION_ID,
      },
      {
        eventKind: "release",
        operationId: segment(CONVERSION_ID, 1),
        amount: 7_000,
        availableDelta: 7_000,
        reservedDelta: -7_000,
        createdAtMs: minute(3),
        cause: CONVERSION_ID,
      },
      {
        eventKind: "reserve",
        operationId: segment(DELETED_CONVERSION_ID, 0),
        amount: 70_000,
        availableDelta: -70_000,
        reservedDelta: 70_000,
        createdAtMs: minute(4),
        cause: DELETED_CONVERSION_ID,
      },
      {
        eventKind: "consume",
        operationId: segment(DELETED_CONVERSION_ID, 0),
        amount: 60_000,
        availableDelta: 10_000,
        reservedDelta: -70_000,
        createdAtMs: minute(5),
        cause: DELETED_CONVERSION_ID,
      },
    ],
    nextCursor: "12",
  };
}

function inspectFixture() {
  return {
    registry: {
      grantId: GRANT_ID,
      requestId: REQUEST_ID,
      label: "Evaluation",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      state: "open",
    },
    authoritative: {
      ...grantFixture("open"),
      allowanceMilliseconds: 7_200_000,
      signingKeyGeneration: 1,
      registrySnapshotRevision: 1,
      registryConfirmedSnapshotRevision: 1,
    },
    registrySnapshotDisagreement: false,
  };
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
