/*
 * The stuck-conversion check on both owners' alarms and the account's stuck-conversion-deletion
 * check, against a Sentry stub (`@cup/sentry-stub`).
 * Both owners run Sentry-wrapped, as in the Worker, and each alarm pass runs at a chosen `nowMs`.
 * A pass that sends nothing is followed by one that reports a second conversion of the same owner,
 * so waiting for that event shows that the quiet pass has flushed too.
 */

import nodeUrl from "node:url";
import { Temporal } from "temporal-polyfill";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

import { startSentryStub, type SentryErrorEvent, type SentryStub } from "@cup/sentry-stub";

import type {
  SentryAccountDurableObject,
  SentryConversionGrantDurableObject,
} from "#test/worker.ts";

type TestEnvironment = {
  SENTRY_ACCOUNTS: DurableObjectNamespace<InstanceType<typeof SentryAccountDurableObject>>;
  SENTRY_CONVERSION_GRANTS: DurableObjectNamespace<
    InstanceType<typeof SentryConversionGrantDurableObject>
  >;
};

const T0_MS = 2_000_000_000_000;
const MINUTE_MS = 60_000;
const NARRATION_TEXT_CHARACTERS_BY_SEGMENT = [100, 100];
/** Each test waits for several end-of-invocation flushes from the Durable Object to the stub. */
const TEST_TIMEOUT_MS = 30_000;

let stub: SentryStub;
const harness = createTestHarness({
  root: nodeUrl.fileURLToPath(new URL("..", import.meta.url)),
  workers: [{ configPath: "./wrangler.test.jsonc" }],
});
const worker = harness.getWorker();
let bindings: TestEnvironment;

beforeAll(async () => {
  stub = await startSentryStub();
  await harness.update({
    root: nodeUrl.fileURLToPath(new URL("..", import.meta.url)),
    workers: [
      { configPath: "./wrangler.test.jsonc", vars: { SENTRY_DSN: stub.dsn("cup-worker") } },
    ],
  });
  await harness.listen();
  const environment: unknown = await worker.getEnv();
  if (!isTestEnvironment(environment)) {
    throw new Error("Stuck-conversion test bindings unavailable");
  }
  bindings = environment;
}, 30_000);

afterAll(async () => {
  await harness.close();
  await stub.close();
}, TEST_TIMEOUT_MS);

test(
  "an account conversion pending 15 minutes after acceptance is reported once, and again only after a retry",
  async () => {
    const { account, accountId } = await createAccount();
    const first = await startAccountConversion(account, T0_MS);
    const second = await startAccountConversion(account, T0_MS + 10 * MINUTE_MS);

    await account.reconcileAtForTest(T0_MS + 14 * MINUTE_MS);
    await account.reconcileAtForTest(T0_MS + 16 * MINUTE_MS);
    await waitForStuckEvents(first, 1);
    expect(stuckEvents(first)[0]).toMatchObject({
      level: "error",
      fingerprint: ["conversion-stuck", "preparation"],
      tags: {
        "cup.conversion.id": first,
        "cup.conversion.stage": "preparation",
        "cup.conversion.phase": "conversion-start",
        "cup.owner.kind": "account",
        "cup.account.id": accountId,
      },
      contexts: { stuck_conversion: { stage: "preparation", age_minutes: 16 } },
    });

    await account.reconcileAtForTest(T0_MS + 20 * MINUTE_MS);
    await account.reconcileAtForTest(T0_MS + 26 * MINUTE_MS);
    await waitForStuckEvents(second, 1);
    expect(stuckEvents(first)).toHaveLength(1);

    await account.settleConversion(
      first,
      { status: "failed", failureCategory: "source-preparation", explanation: "Stopped." },
      T0_MS + 30 * MINUTE_MS,
      1,
    );
    await account.acceptPreparationForTest();
    const retriedAtMs = Temporal.Now.instant().epochMilliseconds;
    await account.retryPreparation(first);
    await account.reconcileAtForTest(retriedAtMs + 14 * MINUTE_MS);
    await account.reconcileAtForTest(retriedAtMs + 16 * MINUTE_MS + 1_000);
    await waitForStuckEvents(first, 2);
    expect(stuckEvents(second)).toHaveLength(1);
  },
  TEST_TIMEOUT_MS,
);

test(
  "an account conversion with a segment reserved 60 minutes after synthesis started is reported once, and again only after synthesis starts again",
  async () => {
    const { account, accountId } = await createAccount();
    const first = await startAccountConversion(account, T0_MS);
    await settleAccountConversionReady(account, accountId, first, T0_MS);
    const second = await startAccountConversion(account, T0_MS);
    await settleAccountConversionReady(account, accountId, second, T0_MS + 10 * MINUTE_MS);

    await account.reconcileAtForTest(T0_MS + 59 * MINUTE_MS);
    await account.reconcileAtForTest(T0_MS + 61 * MINUTE_MS);
    await waitForStuckEvents(first, 1);
    expect(stuckEvents(first)[0]).toMatchObject({
      level: "error",
      fingerprint: ["conversion-stuck", "synthesis"],
      tags: {
        "cup.conversion.id": first,
        "cup.conversion.stage": "synthesis",
        "cup.owner.kind": "account",
        "cup.account.id": accountId,
      },
      contexts: { stuck_conversion: { stage: "synthesis", age_minutes: 61 } },
    });

    await account.reconcileAtForTest(T0_MS + 65 * MINUTE_MS);
    await account.reconcileAtForTest(T0_MS + 71 * MINUTE_MS);
    await waitForStuckEvents(second, 1);
    expect(stuckEvents(first)).toHaveLength(1);

    await account.releaseAudioSegment(first, 0, 1);
    const restartedAtMs = Temporal.Now.instant().epochMilliseconds;
    await account.startSynthesis(first, NARRATION_TEXT_CHARACTERS_BY_SEGMENT, 1);
    await account.reconcileAtForTest(restartedAtMs + 59 * MINUTE_MS);
    await account.reconcileAtForTest(restartedAtMs + 61 * MINUTE_MS + 1_000);
    await waitForStuckEvents(first, 2);
    expect(stuckEvents(second)).toHaveLength(1);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a trial conversion pending 15 minutes after acceptance is reported once, and again only after a retry",
  async () => {
    const { grant, grantId } = await createGrant();
    const first = await startGrantConversion(grant, T0_MS);
    const second = await startGrantConversion(grant, T0_MS + 10 * MINUTE_MS);

    await grant.reconcileAtForTest(T0_MS + 14 * MINUTE_MS);
    await grant.reconcileAtForTest(T0_MS + 16 * MINUTE_MS);
    await waitForStuckEvents(first, 1);
    expect(stuckEvents(first)[0]).toMatchObject({
      level: "error",
      fingerprint: ["conversion-stuck", "preparation"],
      tags: {
        "cup.conversion.id": first,
        "cup.conversion.stage": "preparation",
        "cup.conversion.phase": "conversion-start",
        "cup.owner.kind": "grant",
        "cup.conversion_grant.id": grantId,
      },
      contexts: { stuck_conversion: { stage: "preparation", age_minutes: 16 } },
    });

    await grant.reconcileAtForTest(T0_MS + 20 * MINUTE_MS);
    await grant.reconcileAtForTest(T0_MS + 26 * MINUTE_MS);
    await waitForStuckEvents(second, 1);
    expect(stuckEvents(first)).toHaveLength(1);

    await grant.recordFailed(first, {
      failureCategory: "source-preparation",
      explanation: "Stopped.",
      completedAtMs: T0_MS + 30 * MINUTE_MS,
    });
    const retriedAtMs = Temporal.Now.instant().epochMilliseconds;
    await grant.retryPreparation(first);
    await grant.reconcileAtForTest(retriedAtMs + 14 * MINUTE_MS);
    await grant.reconcileAtForTest(retriedAtMs + 16 * MINUTE_MS + 1_000);
    await waitForStuckEvents(first, 2);
    expect(stuckEvents(second)).toHaveLength(1);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a trial conversion with a segment reserved 60 minutes after synthesis started is reported once, and again only after synthesis starts again",
  async () => {
    const { grant, grantId } = await createGrant();
    const first = await startGrantConversion(grant, T0_MS);
    await recordGrantConversionReady(grant, first, T0_MS);
    const second = await startGrantConversion(grant, T0_MS);
    await recordGrantConversionReady(grant, second, T0_MS + 10 * MINUTE_MS);

    await grant.reconcileAtForTest(T0_MS + 59 * MINUTE_MS);
    await grant.reconcileAtForTest(T0_MS + 61 * MINUTE_MS);
    await waitForStuckEvents(first, 1);
    expect(stuckEvents(first)[0]).toMatchObject({
      level: "error",
      fingerprint: ["conversion-stuck", "synthesis"],
      tags: {
        "cup.conversion.id": first,
        "cup.conversion.stage": "synthesis",
        "cup.owner.kind": "grant",
        "cup.conversion_grant.id": grantId,
      },
      contexts: { stuck_conversion: { stage: "synthesis", age_minutes: 61 } },
    });

    await grant.reconcileAtForTest(T0_MS + 65 * MINUTE_MS);
    await grant.reconcileAtForTest(T0_MS + 71 * MINUTE_MS);
    await waitForStuckEvents(second, 1);
    expect(stuckEvents(first)).toHaveLength(1);

    await grant.releaseAudioSegment(first, 0);
    const restartedAtMs = Temporal.Now.instant().epochMilliseconds;
    await grant.startSynthesis(first, NARRATION_TEXT_CHARACTERS_BY_SEGMENT);
    await grant.reconcileAtForTest(restartedAtMs + 59 * MINUTE_MS);
    await grant.reconcileAtForTest(restartedAtMs + 61 * MINUTE_MS + 1_000);
    await waitForStuckEvents(first, 2);
    expect(stuckEvents(second)).toHaveLength(1);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a conversion that settles before its threshold is never reported",
  async () => {
    const { account, accountId } = await createAccount();
    const settled = await startAccountConversion(account, T0_MS);
    await account.settleConversion(
      settled,
      { status: "failed", failureCategory: "source-preparation", explanation: "Stopped." },
      T0_MS + 5 * MINUTE_MS,
      1,
    );
    const sentinel = await startAccountConversion(account, T0_MS);
    await settleAccountConversionReady(account, accountId, sentinel, T0_MS);

    await account.reconcileAtForTest(T0_MS + 120 * MINUTE_MS);
    await waitForStuckEvents(sentinel, 1);
    expect(stuckEvents(settled)).toEqual([]);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a conversion deletion still marked 1 hour after it was marked is reported once",
  async () => {
    const { account, accountId } = await createAccount();
    // Marked one and five minutes apart, so that each pass after the first report also reports a
    // different deletion before any repeat: Sentry's Dedupe drops only an immediate repeat.
    const first = await startStalledDeletion(account, accountId, T0_MS);
    const second = await startStalledDeletion(account, accountId, T0_MS + MINUTE_MS);
    const third = await startStalledDeletion(account, accountId, T0_MS + 5 * MINUTE_MS);

    await account.reconcileAtForTest(T0_MS + 59 * MINUTE_MS);
    await account.reconcileAtForTest(T0_MS + 62 * MINUTE_MS);
    await waitForDeletionStuckEvents(second, 1);
    expect(deletionStuckEvents(first)).toEqual([
      expect.objectContaining({
        level: "error",
        fingerprint: ["conversion-deletion-stuck"],
        tags: expect.objectContaining({
          "cup.conversion.id": first,
          "cup.component": "account-durable-object",
        }),
      }),
    ]);
    expect(deletionStuckEvents(third)).toEqual([]);

    await account.reconcileAtForTest(T0_MS + 66 * MINUTE_MS);
    await waitForDeletionStuckEvents(third, 1);
    expect(deletionStuckEvents(first)).toHaveLength(1);
    expect(deletionStuckEvents(second)).toHaveLength(1);
    expect(deletionStuckEvents(third)).toHaveLength(1);
  },
  TEST_TIMEOUT_MS,
);

test(
  "an account alarm pass whose step throws sends the error once and still reports a stuck conversion",
  async () => {
    const { account, accountId } = await createAccount();
    const conversionId = await startAccountConversion(account, T0_MS);
    const executionPrefix = `accounts/${accountId}/conversions/${conversionId}/executions/1/`;
    await account.prepareArtifactWrite(
      crypto.randomUUID(),
      1,
      executionPrefix,
      executionPrefix + "audiobook.mp3",
    );
    await account.failArtifactWriterReconciliationForTest();

    expect(await account.failingReconcileAtForTest(T0_MS + 16 * MINUTE_MS)).toBe(
      "Artifact writer reconciliation failed",
    );

    await waitForStuckEvents(conversionId, 1);
    await waitForAlarmFailureEvent("Artifact writer reconciliation failed");
    expect(alarmFailureEvents("Artifact writer reconciliation failed")).toEqual([
      expect.objectContaining({
        level: "error",
        tags: expect.objectContaining({ "cup.component": "account-durable-object" }),
      }),
    ]);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a grant alarm pass whose step throws sends the error once and still reports a stuck conversion",
  async () => {
    const { grant } = await createGrant();
    const conversionId = await startGrantConversion(grant, T0_MS);
    await recordGrantConversionReady(grant, conversionId, T0_MS);
    await grant.stopWorkflowsForTest();
    await grant.failSegmentReleaseForTest();

    expect(await grant.failingReconcileAtForTest(T0_MS + 61 * MINUTE_MS)).toBe(
      "Segment release failed",
    );

    await waitForStuckEvents(conversionId, 1);
    await waitForAlarmFailureEvent("Segment release failed");
    expect(alarmFailureEvents("Segment release failed")).toEqual([
      expect.objectContaining({
        level: "error",
        tags: expect.objectContaining({ "cup.component": "conversion-grant-durable-object" }),
      }),
    ]);
  },
  TEST_TIMEOUT_MS,
);

function waitForAlarmFailureEvent(message: string) {
  return stub.waitFor(
    `the alarm failure "${message}"`,
    () => alarmFailureEvents(message).length > 0,
  );
}

function alarmFailureEvents(message: string): SentryErrorEvent[] {
  return stub
    .errorEvents("cup-worker")
    .filter((event) => event.exception?.values?.some((value) => value.value === message));
}

async function createAccount() {
  const accountId = crypto.randomUUID();
  const account = bindings.SENTRY_ACCOUNTS.get(bindings.SENTRY_ACCOUNTS.idFromName(accountId));
  await account.initialize({ accountId, subject: crypto.randomUUID(), createdAtMs: T0_MS });
  // Enough duration for the tests' two-segment narration documents.
  await account.adjustAllowance(crypto.randomUUID(), 3_600_000, "stuck-conversion-test", T0_MS);
  return { account, accountId };
}

async function startAccountConversion(
  account: Awaited<ReturnType<typeof createAccount>>["account"],
  acceptedAtMs: number,
) {
  const started = await account.startConversion(
    { idempotencyKey: crypto.randomUUID(), sourceUrl: "https://example.com/stuck" },
    acceptedAtMs,
  );
  const conversionId = started.conversion?.conversionId;
  if (conversionId === undefined) {
    throw new Error("Expected an accepted conversion");
  }
  return conversionId;
}

/** Settling ready with the segment lengths reserves the whole document, which starts synthesis. */
async function settleAccountConversionReady(
  account: Awaited<ReturnType<typeof createAccount>>["account"],
  accountId: string,
  conversionId: string,
  readyAtMs: number,
) {
  await account.settleConversion(
    conversionId,
    {
      status: "ready",
      title: "Book",
      audiobookReference: {
        key: `accounts/${accountId}/conversions/${conversionId}/executions/1/audiobook.json`,
        contentType: "application/json",
        byteLength: 123,
        etag: "fixture",
      },
    },
    readyAtMs,
    1,
    NARRATION_TEXT_CHARACTERS_BY_SEGMENT,
  );
}

/**
 * Marks a conversion for deletion at `markedAtMs` behind a writer whose put never lands, so every
 * cleanup pass waits on the undrained writer and the conversion stays marked.
 */
async function startStalledDeletion(
  account: Awaited<ReturnType<typeof createAccount>>["account"],
  accountId: string,
  markedAtMs: number,
) {
  const conversionId = await startAccountConversion(account, markedAtMs);
  const executionPrefix = `accounts/${accountId}/conversions/${conversionId}/executions/1/`;
  await account.prepareArtifactWrite(
    crypto.randomUUID(),
    1,
    executionPrefix,
    executionPrefix + "audiobook.mp3",
  );
  expect(await account.deleteConversion(conversionId, markedAtMs)).toEqual({ result: "marked" });
  return conversionId;
}

async function createGrant() {
  const grantId = crypto.randomUUID();
  const grant = bindings.SENTRY_CONVERSION_GRANTS.get(
    bindings.SENTRY_CONVERSION_GRANTS.idFromName(grantId),
  );
  await grant.initialize(grantId, T0_MS, T0_MS + 90 * 24 * 60 * MINUTE_MS);
  return { grant, grantId };
}

async function startGrantConversion(
  grant: Awaited<ReturnType<typeof createGrant>>["grant"],
  acceptedAtMs: number,
) {
  const started = await grant.startConversion(
    "https://example.com/stuck",
    crypto.randomUUID(),
    acceptedAtMs,
  );
  if (started.result !== "created") {
    throw new Error(`Expected an accepted conversion, got ${started.result}`);
  }
  return started.conversion.conversionId;
}

/** Recording ready with the segment lengths reserves the whole document, which starts synthesis. */
async function recordGrantConversionReady(
  grant: Awaited<ReturnType<typeof createGrant>>["grant"],
  conversionId: string,
  readyAtMs: number,
) {
  await grant.recordReady(
    conversionId,
    {
      completedAtMs: readyAtMs,
      title: "Book",
      audiobookReference: {
        key: `conversions/${conversionId}/audiobook.json`,
        contentType: "application/json",
        byteLength: 42,
        etag: "fixture",
      },
    },
    NARRATION_TEXT_CHARACTERS_BY_SEGMENT,
  );
}

function stuckEvents(conversionId: string): SentryErrorEvent[] {
  return stub
    .errorEvents("cup-worker")
    .filter((event) => event.tags?.["cup.conversion.id"] === conversionId);
}

function waitForStuckEvents(conversionId: string, count: number) {
  return stub.waitFor(
    `${count} stuck-conversion event(s) of ${conversionId}`,
    () => stuckEvents(conversionId).length >= count,
  );
}

function deletionStuckEvents(conversionId: string): SentryErrorEvent[] {
  return stub
    .errorEvents("cup-worker")
    .filter(
      (event) =>
        event.tags?.["cup.conversion.id"] === conversionId &&
        JSON.stringify(event["fingerprint"]) === JSON.stringify(["conversion-deletion-stuck"]),
    );
}

function waitForDeletionStuckEvents(conversionId: string, count: number) {
  return stub.waitFor(
    `${count} stuck-conversion-deletion event(s) of ${conversionId}`,
    () => deletionStuckEvents(conversionId).length >= count,
  );
}

function isTestEnvironment(value: unknown): value is TestEnvironment {
  return (
    typeof value === "object" &&
    value !== null &&
    "SENTRY_ACCOUNTS" in value &&
    "SENTRY_CONVERSION_GRANTS" in value
  );
}
