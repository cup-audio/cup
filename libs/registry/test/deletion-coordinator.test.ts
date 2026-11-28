import nodeUrl from "node:url";
import { Temporal } from "temporal-polyfill";
import { afterAll, beforeAll, test, type TestContext } from "vitest";
import { createTestHarness } from "wrangler";

import type { AccountDurableObject } from "@cup/accounts";
import type { DeletionAttempt } from "@cup/accounts/lifecycle";
import { resendError, useResendStub, type ResendStub } from "@cup/resend-stub";
import { useSentryStub } from "@cup/sentry-stub";

import type { DeletionTestDurableObject } from "#test/worker.ts";

type TestEnvironment = {
  ACCOUNTS: DurableObjectNamespace<AccountDurableObject>;
  DELETION_TEST: DurableObjectNamespace<DeletionTestDurableObject>;
};

const SHORT_TIMEOUT_MS = 300;
const DEFAULT_TIMEOUT_MS = 5_000;
const RECIPIENT = "listener@example.com";
const MINUTE_MS = 60_000;

const harness = createTestHarness({
  root: nodeUrl.fileURLToPath(new URL("..", import.meta.url)),
  workers: [{ configPath: "./wrangler.test.jsonc" }],
});
const worker = harness.getWorker();
let bindings: TestEnvironment;

beforeAll(async () => {
  await harness.listen();
  const environment: unknown = await worker.getEnv();
  if (!isTestEnvironment(environment)) {
    throw new Error("Deletion test bindings unavailable");
  }
  bindings = environment;
}, 30_000);

afterAll(async () => {
  await harness.close();
});

test("a deletion notice is sent once with its notification key and then purged", async ({
  expect,
  onTestFinished,
}) => {
  const stub = await useResendStub({ onTestFinished });
  const coordinator = await scheduledCoordinator();

  await coordinator.reconcile(stub);

  expect(await coordinator.notification()).toMatchObject({ state: "sent", attempts: 1, email: "" });
  expect(stub.requests).toStrictEqual([
    {
      method: "POST",
      pathname: "/emails",
      authorization: "Bearer test-resend",
      userAgent: "cup",
      idempotencyKey: coordinator.key,
      body: {
        from: "Cup <no-reply@cup.audio>",
        to: [RECIPIENT],
        subject: "Your Cup account deletion is scheduled",
        text: expect.stringContaining('choose "Restore account"'),
      },
    },
  ]);
  expectExactlyOneEmail(expect, stub, coordinator.key);
});

test("a retry after a lost response replays the key and delivers exactly one email", async ({
  expect,
  onTestFinished,
}) => {
  const stub = await useResendStub({ onTestFinished });
  const coordinator = await scheduledCoordinator();
  const held = stub.holdNext();

  const reconciling = coordinator.reconcile(stub, SHORT_TIMEOUT_MS);
  await held.received;
  await reconciling;
  expect(await coordinator.notification()).toMatchObject({ state: "pending", attempts: 1 });
  held.release();
  await expect.poll(() => stub.emails).toHaveLength(1);
  await coordinator.makeNotificationDue();
  await coordinator.reconcile(stub);

  expect(await coordinator.notification()).toMatchObject({ state: "sent", attempts: 2 });
  expect(stub.requests).toHaveLength(2);
  expectExactlyOneEmail(expect, stub, coordinator.key);
});

test("a retry while the first request is still in progress gets 409 and retries again later", async ({
  expect,
  onTestFinished,
}) => {
  const stub = await useResendStub({ onTestFinished });
  const coordinator = await scheduledCoordinator();
  const held = stub.holdNext();
  const reconciling = coordinator.reconcile(stub, SHORT_TIMEOUT_MS);
  await held.received;
  await reconciling;

  await coordinator.makeNotificationDue();
  await coordinator.reconcile(stub, SHORT_TIMEOUT_MS);
  expect(await coordinator.notification()).toMatchObject({ state: "pending", attempts: 2 });
  held.release();
  await expect.poll(() => stub.emails).toHaveLength(1);
  await coordinator.makeNotificationDue();
  await coordinator.reconcile(stub);

  expect(await coordinator.notification()).toMatchObject({ state: "sent", attempts: 3 });
  expectExactlyOneEmail(expect, stub, coordinator.key);
});

test("a request timeout leaves the notice pending, and the retry delivers exactly one email", async ({
  expect,
  onTestFinished,
}) => {
  const stub = await useResendStub({ onTestFinished });
  const coordinator = await scheduledCoordinator();
  stub.hangNext();
  const before = Temporal.Now.instant().epochMilliseconds;

  await coordinator.reconcile(stub, SHORT_TIMEOUT_MS);

  const pending = await coordinator.notification();
  expect(pending).toMatchObject({ state: "pending", attempts: 1 });
  expect(pending.nextAttemptMs).toBeGreaterThanOrEqual(before + 60_000);
  expect(stub.emails).toStrictEqual([]);
  await coordinator.makeNotificationDue();
  await coordinator.reconcile(stub);
  expect(await coordinator.notification()).toMatchObject({ state: "sent", attempts: 2 });
  expectExactlyOneEmail(expect, stub, coordinator.key);
});

test("a final 4xx refusal fails the notice without retrying it", async ({
  expect,
  onTestFinished,
}) => {
  const stub = await useResendStub({ onTestFinished });
  const coordinator = await scheduledCoordinator();
  stub.respondNext(resendError(422, "validation_error", "Invalid `to` field."));

  await coordinator.reconcile(stub);
  await coordinator.makeNotificationDue();
  await coordinator.reconcile(stub);

  expect(await coordinator.notification()).toMatchObject({
    state: "failed",
    attempts: 1,
    email: "",
    text: "",
  });
  expect(stub.requests).toHaveLength(1);
  expect(stub.emails).toStrictEqual([]);
});

test.for([
  {
    name: "429 rate limit",
    response: {
      ...resendError(429, "rate_limit_exceeded", "Too many requests."),
      headers: { "Retry-After": "3600" },
    },
    retryAfterMs: 3_600_000,
  },
  {
    name: "503 with a non-JSON body",
    response: {
      status: 503,
      rawBody: "<html>Service unavailable</html>",
      headers: { "Content-Type": "text/html", "Retry-After": "120" },
    },
    retryAfterMs: 120_000,
  },
])(
  "a $name is retried no earlier than Retry-After and delivers exactly one email",
  async ({ response, retryAfterMs }, { expect, onTestFinished }) => {
    const stub = await useResendStub({ onTestFinished });
    const coordinator = await scheduledCoordinator();
    stub.respondNext(response);
    const before = Temporal.Now.instant().epochMilliseconds;

    await coordinator.reconcile(stub);

    const pending = await coordinator.notification();
    expect(pending).toMatchObject({ state: "pending", attempts: 1 });
    expect(pending.nextAttemptMs).toBeGreaterThanOrEqual(before + retryAfterMs);
    expect(stub.emails).toStrictEqual([]);
    await coordinator.makeNotificationDue();
    await coordinator.reconcile(stub);
    expect(await coordinator.notification()).toMatchObject({ state: "sent", attempts: 2 });
    expectExactlyOneEmail(expect, stub, coordinator.key);
  },
);

test("a restore accepted while the coordinator awaits the account fence supersedes the deletion", async ({
  expect,
  onTestFinished,
}) => {
  const stub = await useResendStub({ onTestFinished });
  const attempt = await restoredAccountAttempt();
  const name = crypto.randomUUID();
  const coordinator = bindings.DELETION_TEST.get(bindings.DELETION_TEST.idFromName(name));
  await coordinator.acceptForTest(attempt);
  const storage = await worker.getDurableObjectStorage("DELETION_TEST", { name });
  await storage.exec(
    "UPDATE deletion_jobs SET payload_json = json_set(payload_json, '$.nextAttemptMs', 0)",
  );
  await coordinator.holdNextAccountCallForTest("fenceDeletion");

  const reconciling = coordinator.reconcileWithProvidersForTest(stub.url, DEFAULT_TIMEOUT_MS);
  await coordinator.accountCallReachedForTest();
  await coordinator.acceptForTest({ ...attempt, state: "restored" });
  await coordinator.releaseAccountCallForTest();
  await reconciling;

  expect(await coordinator.statusForTest()).toStrictEqual([]);
  expect(await storage.exec("SELECT attempt_id FROM canceled_deletion_attempts")).toStrictEqual([
    { attempt_id: attempt.attemptId },
  ]);
  expect(stub.requests).toStrictEqual([]);
});

test.for([
  { pending: "both", state: "scheduled", identityDone: false, accountDone: false },
  { pending: "account", state: "deleting", identityDone: true, accountDone: false },
  { pending: "identity", state: "deleting", identityDone: false, accountDone: true },
])(
  "an account deletion still not erased 1 h after its deadline is reported once, pending $pending",
  { timeout: 15_000 },
  async ({ pending, ...progress }, { expect, onTestFinished }) => {
    const sentry = await useSentryStub({ onTestFinished });
    const coordinator = await sentryCoordinator({
      onTestFinished,
      sentryDsn: sentry.dsn("cup-worker"),
    });
    const nowMs = Temporal.Now.instant().epochMilliseconds;
    const stuckFirst = await coordinator.accept(nowMs - 61 * MINUTE_MS, progress);
    const stuckSecond = await coordinator.accept(nowMs - 62 * MINUTE_MS, progress);
    const almostStuck = await coordinator.accept(nowMs - 59 * MINUTE_MS, progress);

    await coordinator.reconcile();

    await sentry.waitFor("both stuck reports", () => sentry.errorEvents("cup-worker").length >= 2);
    expect(sentry.errorEvents("cup-worker")).toStrictEqual(
      expect.arrayContaining(
        [stuckFirst, stuckSecond].map((attempt) =>
          expect.objectContaining({
            level: "error",
            fingerprint: ["account-deletion-stuck"],
            tags: expect.objectContaining({
              "cup.component": "registry-durable-object",
              "cup.account.id": attempt.accountId,
              "cup.account_deletion.attempt_id": attempt.attemptId,
              "cup.account_deletion.pending": pending,
            }),
          }),
        ),
      ),
    );
    expect(sentry.errorEvents("cup-worker")).toHaveLength(2);
    expect(JSON.stringify(sentry.envelopes)).not.toContain(RECIPIENT);
    expect(await coordinator.overdueByAttempt()).toStrictEqual({
      [stuckFirst.attemptId]: true,
      [stuckSecond.attemptId]: true,
      [almostStuck.attemptId]: false,
    });

    await coordinator.reconcile();
    await coordinator.moveDeadline(almostStuck.attemptId, nowMs - 61 * MINUTE_MS);
    await coordinator.reconcile();

    await sentry.waitFor("the third stuck report", () =>
      sentry
        .errorEvents("cup-worker")
        .some(({ tags }) => tags?.["cup.account_deletion.attempt_id"] === almostStuck.attemptId),
    );
    expect(sentry.errorEvents("cup-worker")).toHaveLength(3);
  },
);

test("the Apple revocation recorded at scheduling stays on the deletion job and lands in the receipt", async ({
  expect,
}) => {
  const attempt = await scheduledAccountAttempt("revoked");
  const name = crypto.randomUUID();
  const coordinator = bindings.DELETION_TEST.get(bindings.DELETION_TEST.idFromName(name));
  await coordinator.acceptForTest(attempt);
  const storage = await worker.getDurableObjectStorage("DELETION_TEST", { name });

  expect(
    await storage.exec(
      "SELECT json_extract(payload_json, '$.appleRevocation') AS apple FROM deletion_jobs",
    ),
  ).toStrictEqual([{ apple: "revoked" }]);

  await storage.exec(
    `UPDATE deletion_jobs SET payload_json = json_set(payload_json, '$.state', 'deleting',
      '$.accountDone', json('true'), '$.nextAttemptMs', 0)`,
  );
  await coordinator.reconcileForTest();
  const receipts = await coordinator.reconcileForTest();

  expect(receipts.map(({ result }) => JSON.parse(result))).toStrictEqual([
    expect.objectContaining({ result: "erased", appleRevocation: "revoked" }),
  ]);
});

test("an operator-scheduled deletion records not-revoked, lists both revocations, sends the usual notice, and refuses a second scheduling", async ({
  expect,
  onTestFinished,
}) => {
  const stub = await useResendStub({ onTestFinished });
  const accountId = crypto.randomUUID();
  const account = bindings.ACCOUNTS.get(bindings.ACCOUNTS.idFromName(accountId));
  await account.initialize({
    accountId,
    subject: crypto.randomUUID(),
    createdAtMs: Temporal.Now.instant().epochMilliseconds,
  });

  await expectRejection(account.scheduleOperatorDeletion(RECIPIENT));

  expect((await account.inspect()).state).toBe("deletion_scheduled");
  await expect(account.scheduleOperatorDeletion(RECIPIENT)).resolves.toEqual({
    result: "conflict",
  });
  const accountStorage = await worker.getDurableObjectStorage("ACCOUNTS", { name: accountId });
  const [row] = await accountStorage.exec("SELECT payload_json FROM deletion_attempts");
  if (typeof row?.["payload_json"] !== "string") {
    throw new Error("The account was not scheduled for deletion");
  }
  const attempt: DeletionAttempt = JSON.parse(row["payload_json"]);
  expect(attempt).toMatchObject({ accountId, email: RECIPIENT, appleRevocation: "not-revoked" });
  const coordinator = bindings.DELETION_TEST.get(
    bindings.DELETION_TEST.idFromName(crypto.randomUUID()),
  );
  await coordinator.acceptForTest({ ...attempt, state: "scheduled" });

  expect(await coordinator.statusForTest()).toStrictEqual([
    expect.objectContaining({
      attemptId: attempt.attemptId,
      googleRevocation: "unavailable",
      appleRevocation: "not-revoked",
    }),
  ]);
  await coordinator.reconcileWithProvidersForTest(stub.url, DEFAULT_TIMEOUT_MS);
  expect(stub.emails).toStrictEqual([
    expect.objectContaining({
      idempotencyKey: `${attempt.attemptId}:scheduled`,
      email: expect.objectContaining({
        to: [RECIPIENT],
        subject: "Your Cup account deletion is scheduled",
      }),
    }),
  ]);
});

async function sentryCoordinator({
  onTestFinished,
  sentryDsn,
}: Pick<TestContext, "onTestFinished"> & { sentryDsn: string }) {
  const sentryHarness = createTestHarness({
    root: nodeUrl.fileURLToPath(new URL("..", import.meta.url)),
    workers: [{ configPath: "./wrangler.test.jsonc", vars: { SENTRY_DSN: sentryDsn } }],
  });
  onTestFinished(() => sentryHarness.close());
  await sentryHarness.listen();
  const sentryWorker = sentryHarness.getWorker();
  const environment: unknown = await sentryWorker.getEnv();
  if (!isSentryTestEnvironment(environment)) {
    throw new Error("Sentry deletion test binding unavailable");
  }
  const name = crypto.randomUUID();
  const object = environment.SENTRY_DELETION_TEST.get(
    environment.SENTRY_DELETION_TEST.idFromName(name),
  );
  const storage = await sentryWorker.getDurableObjectStorage("SENTRY_DELETION_TEST", { name });
  return {
    async accept(
      deadlineMs: number,
      progress: { state: string; identityDone: boolean; accountDone: boolean },
    ) {
      const attempt: DeletionAttempt = {
        attemptId: crypto.randomUUID(),
        accountId: crypto.randomUUID(),
        subject: crypto.randomUUID(),
        email: RECIPIENT,
        scheduledAtMs: deadlineMs - 7 * 86_400_000,
        deadlineMs,
        state: "scheduled",
        appleRevocation: "unavailable",
      };
      await object.acceptForTest(attempt);
      await storage.exec(
        `UPDATE deletion_jobs SET payload_json = json_set(payload_json, '$.state', ?,
          '$.identityDone', json(?), '$.accountDone', json(?), '$.nextAttemptMs', ?)
        WHERE attempt_id = ?`,
        progress.state,
        String(progress.identityDone),
        String(progress.accountDone),
        Number.MAX_SAFE_INTEGER,
        attempt.attemptId,
      );
      return attempt;
    },
    async moveDeadline(attemptId: string, deadlineMs: number) {
      await storage.exec(
        "UPDATE deletion_jobs SET payload_json = json_set(payload_json, '$.deadlineMs', ?) WHERE attempt_id = ?",
        deadlineMs,
        attemptId,
      );
    },
    reconcile: () => object.reconcileForTest(),
    async overdueByAttempt() {
      return Object.fromEntries(
        (await object.statusForTest()).map(({ attemptId, overdue }) => [attemptId, overdue]),
      );
    },
  };
}

async function scheduledCoordinator() {
  const name = crypto.randomUUID();
  const object = bindings.DELETION_TEST.get(bindings.DELETION_TEST.idFromName(name));
  const nowMs = Temporal.Now.instant().epochMilliseconds;
  const attempt: DeletionAttempt = {
    attemptId: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    subject: crypto.randomUUID(),
    email: RECIPIENT,
    scheduledAtMs: nowMs,
    deadlineMs: nowMs + 7 * 86_400_000,
    state: "scheduled",
    appleRevocation: "unavailable",
  };
  await object.acceptForTest(attempt);
  const storage = await worker.getDurableObjectStorage("DELETION_TEST", { name });
  const key = `${attempt.attemptId}:scheduled`;
  return {
    key,
    reconcile: (stub: ResendStub, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      object.reconcileWithProvidersForTest(stub.url, timeoutMs),
    async notification() {
      const [row] = await storage.exec(
        `SELECT json_extract(payload_json, '$.state') AS state,
          json_extract(payload_json, '$.attempts') AS attempts,
          json_extract(payload_json, '$.nextAttemptMs') AS nextAttemptMs,
          json_extract(payload_json, '$.email') AS email,
          json_extract(payload_json, '$.text') AS text
        FROM deletion_notifications WHERE notification_key = ?`,
        key,
      );
      if (row === undefined) {
        throw new Error(`Notification ${key} is missing`);
      }
      return { ...row, nextAttemptMs: Number(row["nextAttemptMs"]) };
    },
    async makeNotificationDue() {
      await storage.exec(
        "UPDATE deletion_notifications SET payload_json = json_set(payload_json, '$.nextAttemptMs', 0) WHERE notification_key = ?",
        key,
      );
    },
  };
}

async function restoredAccountAttempt(): Promise<DeletionAttempt> {
  const accountId = crypto.randomUUID();
  const account = bindings.ACCOUNTS.get(bindings.ACCOUNTS.idFromName(accountId));
  await account.initialize({
    accountId,
    subject: crypto.randomUUID(),
    createdAtMs: Temporal.Now.instant().epochMilliseconds,
  });
  const schedule = await account.deletionChallenge();
  await expectRejection(
    account.scheduleDeletion({
      challengeId: schedule.challengeId,
      authenticatedAtSeconds: Math.floor(schedule.issuedAtMs / 1000) + 1,
      email: RECIPIENT,
      appleRevocation: "unavailable",
    }),
  );
  const storage = await worker.getDurableObjectStorage("ACCOUNTS", { name: accountId });
  const [row] = await storage.exec("SELECT payload_json FROM deletion_attempts");
  const restore = await account.deletionChallenge();
  await expectRejection(
    account.restoreAccount(restore.challengeId, Math.floor(restore.issuedAtMs / 1000) + 1),
  );
  if ((await account.inspect()).state !== "active" || typeof row?.["payload_json"] !== "string") {
    throw new Error("The account was not scheduled for deletion and restored");
  }
  const scheduled: DeletionAttempt = JSON.parse(row["payload_json"]);
  return { ...scheduled, state: "scheduled" };
}

function expectExactlyOneEmail(expect: TestContext["expect"], stub: ResendStub, key: string) {
  expect(stub.emails.map(({ idempotencyKey }) => idempotencyKey)).toStrictEqual([key]);
  const bodies = stub.requests
    .filter(({ idempotencyKey }) => idempotencyKey === key)
    .map(({ body }) => JSON.stringify(body));
  expect(new Set(bodies).size).toBe(1);
}

async function scheduledAccountAttempt(
  appleRevocation: "unavailable" | "revoked" | "not-revoked",
): Promise<DeletionAttempt> {
  const accountId = crypto.randomUUID();
  const account = bindings.ACCOUNTS.get(bindings.ACCOUNTS.idFromName(accountId));
  await account.initialize({
    accountId,
    subject: crypto.randomUUID(),
    createdAtMs: Temporal.Now.instant().epochMilliseconds,
  });
  const schedule = await account.deletionChallenge();
  await expectRejection(
    account.scheduleDeletion({
      challengeId: schedule.challengeId,
      authenticatedAtSeconds: Math.floor(schedule.issuedAtMs / 1000) + 1,
      email: RECIPIENT,
      appleRevocation,
    }),
  );
  const storage = await worker.getDurableObjectStorage("ACCOUNTS", { name: accountId });
  const [row] = await storage.exec("SELECT payload_json FROM deletion_attempts");
  if (typeof row?.["payload_json"] !== "string") {
    throw new Error("The account was not scheduled for deletion");
  }
  const scheduled: DeletionAttempt = JSON.parse(row["payload_json"]);
  return { ...scheduled, state: "scheduled" };
}

async function expectRejection(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    return;
  }
  throw new Error("Expected the Durable Object operation to reject");
}

function isSentryTestEnvironment(
  value: unknown,
): value is { SENTRY_DELETION_TEST: DurableObjectNamespace<DeletionTestDurableObject> } {
  return typeof value === "object" && value !== null && "SENTRY_DELETION_TEST" in value;
}

function isTestEnvironment(value: unknown): value is TestEnvironment {
  return (
    typeof value === "object" && value !== null && "ACCOUNTS" in value && "DELETION_TEST" in value
  );
}
