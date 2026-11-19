/*
 * The conversion outcome `info` events both owners send when they record an outcome, and the
 * issues their alarms open for a Workflow that stopped, against a Sentry stub (`@cup/sentry-stub`).
 * Both owners run Sentry-wrapped, as in the Worker.
 */

import nodeUrl from "node:url";
import { Temporal } from "temporal-polyfill";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestHarness } from "wrangler";

import {
  startSentryStub,
  type SentryErrorEvent,
  type SentryLog,
  type SentryStub,
} from "@cup/sentry-stub";

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
    throw new Error("Conversion outcome test bindings unavailable");
  }
  bindings = environment;
}, 30_000);

afterAll(async () => {
  await harness.close();
  await stub.close();
}, TEST_TIMEOUT_MS);

test(
  "a trial conversion's preparation, segments and synthesis each send an info event with their outcome and duration",
  async () => {
    const { grant } = await createGrant();
    const createdAtMs = Temporal.Now.instant().epochMilliseconds - 10 * MINUTE_MS;
    const conversionId = await startGrantConversion(grant, createdAtMs);

    await grant.recordReady(
      conversionId,
      { ...readyGrantOutcome(conversionId), completedAtMs: createdAtMs + 5 * MINUTE_MS },
      NARRATION_TEXT_CHARACTERS_BY_SEGMENT,
    );
    await waitForLogs("conversion-preparation-settled", conversionId, 1);
    expect(logs("conversion-preparation-settled", conversionId)[0]).toMatchObject({
      level: "info",
      attributes: {
        "cup.conversion.id": { value: conversionId },
        "cup.conversion.outcome": { value: "ready" },
        "cup.conversion.elapsed_ms": { value: 5 * MINUTE_MS },
      },
    });

    await grant.completeAudioSegment(conversionId, 0, 1_000, 2);
    await grant.releaseAudioSegment(conversionId, 1, 3);
    await waitForLogs("audio-segment-settled", conversionId, 2);
    const [settled, released] = logs("audio-segment-settled", conversionId);
    expect(settled).toMatchObject({
      level: "info",
      attributes: {
        "cup.conversion.id": { value: conversionId },
        "cup.audio_segment.sequence": { value: 0 },
        "cup.audio_segment.outcome": { value: "settled" },
        "cup.audio_segment.attempts": { value: 2 },
      },
    });
    expect(settled?.attributes["cup.audio_segment.reserved_ms"]?.value).toBeGreaterThanOrEqual(0);
    expect(released).toMatchObject({
      attributes: {
        "cup.audio_segment.sequence": { value: 1 },
        "cup.audio_segment.outcome": { value: "released" },
        "cup.audio_segment.attempts": { value: 3 },
      },
    });

    // The release settled the last reserved segment; the settlement before it left one reserved.
    await waitForLogs("conversion-synthesis-settled", conversionId, 1);
    const synthesisSettled = logs("conversion-synthesis-settled", conversionId);
    expect(synthesisSettled).toHaveLength(1);
    expect(synthesisSettled[0]).toMatchObject({
      level: "info",
      attributes: {
        "cup.conversion.id": { value: conversionId },
        "cup.conversion.failed_segments": { value: 1 },
      },
    });
    expect(
      synthesisSettled[0]?.attributes["cup.conversion.elapsed_ms"]?.value,
    ).toBeGreaterThanOrEqual(10 * MINUTE_MS);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a failed trial preparation sends its failure category",
  async () => {
    const { grant } = await createGrant();
    const createdAtMs = Temporal.Now.instant().epochMilliseconds;
    const conversionId = await startGrantConversion(grant, createdAtMs);

    await grant.recordFailed(conversionId, {
      failureCategory: "content-selection",
      explanation: "Stopped.",
      completedAtMs: createdAtMs + 2 * MINUTE_MS,
    });

    await waitForLogs("conversion-preparation-settled", conversionId, 1);
    expect(logs("conversion-preparation-settled", conversionId)[0]).toMatchObject({
      attributes: {
        "cup.conversion.id": { value: conversionId },
        "cup.conversion.outcome": { value: "failed" },
        "cup.conversion.failure_category": { value: "content-selection" },
        "cup.conversion.elapsed_ms": { value: 2 * MINUTE_MS },
      },
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a prepared trial conversion that does not fit the available duration settles as insufficient-duration",
  async () => {
    const { grant } = await createGrant();
    const createdAtMs = Temporal.Now.instant().epochMilliseconds;
    const conversionId = await startGrantConversion(grant, createdAtMs);

    await grant.recordReady(
      conversionId,
      { ...readyGrantOutcome(conversionId), completedAtMs: createdAtMs + MINUTE_MS },
      // Far more narration than a new grant's duration allowance covers.
      [10_000_000],
    );

    await waitForLogs("conversion-preparation-settled", conversionId, 1);
    expect(logs("conversion-preparation-settled", conversionId)[0]).toMatchObject({
      attributes: {
        "cup.conversion.outcome": { value: "insufficient-duration" },
        "cup.conversion.elapsed_ms": { value: MINUTE_MS },
      },
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "an account conversion whose segments all settle sends its synthesis outcome without failed segments",
  async () => {
    const { account, accountId } = await createAccount();
    const createdAtMs = Temporal.Now.instant().epochMilliseconds - 10 * MINUTE_MS;
    const conversionId = await startAccountConversion(account, createdAtMs);

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
      createdAtMs + 3 * MINUTE_MS,
      1,
      NARRATION_TEXT_CHARACTERS_BY_SEGMENT,
    );
    await account.completeAudioSegment(conversionId, 0, 1_000, 1, 1);
    await account.completeAudioSegment(conversionId, 1, 1_000, 1, 1);

    await waitForLogs("conversion-synthesis-settled", conversionId, 1);
    expect(logs("conversion-preparation-settled", conversionId)[0]).toMatchObject({
      attributes: {
        "cup.conversion.outcome": { value: "ready" },
        "cup.conversion.elapsed_ms": { value: 3 * MINUTE_MS },
      },
    });
    expect(logs("audio-segment-settled", conversionId)).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({
          "cup.audio_segment.sequence": expect.objectContaining({ value: 0 }),
          "cup.audio_segment.outcome": expect.objectContaining({ value: "settled" }),
          "cup.audio_segment.attempts": expect.objectContaining({ value: 1 }),
        }),
      }),
      expect.objectContaining({
        attributes: expect.objectContaining({
          "cup.audio_segment.sequence": expect.objectContaining({ value: 1 }),
        }),
      }),
    ]);
    const [synthesisSettled] = logs("conversion-synthesis-settled", conversionId);
    expect(synthesisSettled).toMatchObject({
      attributes: {
        "cup.conversion.id": { value: conversionId },
        "cup.conversion.failed_segments": { value: 0 },
      },
    });
    expect(synthesisSettled?.attributes["cup.conversion.elapsed_ms"]?.value).toBeGreaterThanOrEqual(
      10 * MINUTE_MS,
    );
  },
  TEST_TIMEOUT_MS,
);

test(
  "a trial preparation whose Workflow stopped opens one issue, whose event ID is the failed outcome's diagnostic reference",
  async () => {
    const { grant, grantId } = await createGrant();
    const conversionId = await startGrantConversion(
      grant,
      Temporal.Now.instant().epochMilliseconds,
    );
    await grant.stopWorkflowsForTest();

    await grant.reconcileAtForTest(Temporal.Now.instant().epochMilliseconds);

    await waitForFailureEvents(conversionId, 1);
    const events = failureEvents(conversionId);
    expect(events).toEqual([
      expect.objectContaining({
        tags: expect.objectContaining({
          "cup.conversion.failure_category": "workflow-platform",
          "cup.owner.kind": "grant",
          "cup.conversion_grant.id": grantId,
        }),
      }),
    ]);
    const conversion = await grant.getConversion(conversionId);
    expect(conversion?.status === "failed" && conversion.diagnosticReference).toBe(
      events[0]?.event_id,
    );
  },
  TEST_TIMEOUT_MS,
);

test(
  "an account preparation whose Workflow stopped opens one issue",
  async () => {
    const { account, accountId } = await createAccount();
    await account.acceptPreparationForTest();
    const conversionId = await startAccountConversion(
      account,
      Temporal.Now.instant().epochMilliseconds,
    );
    await account.stopWorkflowsForTest();

    await account.reconcileForTest();

    await waitForFailureEvents(conversionId, 1);
    expect(failureEvents(conversionId)).toEqual([
      expect.objectContaining({
        tags: expect.objectContaining({
          "cup.conversion.failure_category": "workflow-platform",
          "cup.owner.kind": "account",
          "cup.account.id": accountId,
        }),
      }),
    ]);
    expect((await account.getConversion(conversionId))?.outcome).toMatchObject({
      status: "failed",
      failureCategory: "workflow-platform",
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "each trial segment that the alarm releases because its Workflow stopped opens one issue",
  async () => {
    const { grant } = await createGrant();
    const conversionId = await startGrantConversion(
      grant,
      Temporal.Now.instant().epochMilliseconds,
    );
    await grant.recordReady(
      conversionId,
      readyGrantOutcome(conversionId),
      NARRATION_TEXT_CHARACTERS_BY_SEGMENT,
    );
    await grant.stopWorkflowsForTest();

    await grant.reconcileAtForTest(Temporal.Now.instant().epochMilliseconds);

    await waitForFailureEvents(conversionId, 2);
    expect(
      failureEvents(conversionId).map((event) => [
        event.tags?.["cup.conversion.failure_category"],
        event.tags?.["cup.audio_segment.sequence"],
      ]),
    ).toEqual([
      ["segment", "0"],
      ["segment", "1"],
    ]);
  },
  TEST_TIMEOUT_MS,
);

test(
  "each account segment that the alarm releases because its Workflow stopped opens one issue",
  async () => {
    const { account, accountId } = await createAccount();
    const conversionId = await startAccountConversion(
      account,
      Temporal.Now.instant().epochMilliseconds,
    );
    await account.settleConversion(
      conversionId,
      readyAccountOutcome(accountId, conversionId),
      Temporal.Now.instant().epochMilliseconds,
      1,
      NARRATION_TEXT_CHARACTERS_BY_SEGMENT,
    );
    await account.stopWorkflowsForTest();

    await account.reconcileForTest();

    await waitForFailureEvents(conversionId, 2);
    expect(
      failureEvents(conversionId).map((event) => [
        event.tags?.["cup.conversion.failure_category"],
        event.tags?.["cup.audio_segment.sequence"],
      ]),
    ).toEqual([
      ["segment", "0"],
      ["segment", "1"],
    ]);
  },
  TEST_TIMEOUT_MS,
);

test(
  "an account conversion whose preparation cannot be dispatched logs a warning, and the alarm retries it",
  async () => {
    const { account } = await createAccount();

    // The test object refuses to create preparation Workflows until a test accepts them.
    const conversionId = await startAccountConversion(
      account,
      Temporal.Now.instant().epochMilliseconds,
    );

    await waitForLogs("conversion-dispatch-failed", conversionId, 1);
    expect(logs("conversion-dispatch-failed", conversionId)[0]).toMatchObject({
      level: "warn",
      attributes: { "exception.type": { value: "Error" } },
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a trial conversion whose preparation Workflow cannot be reached logs a warning on the alarm pass",
  async () => {
    const { grant } = await createGrant();
    const nowMs = Temporal.Now.instant().epochMilliseconds;
    const conversionId = await startGrantConversion(grant, nowMs);

    // The test object's Workflow instances report no status.
    await grant.reconcileAtForTest(nowMs);

    await waitForLogs("conversion-dispatch-failed", conversionId, 1);
    expect(logs("conversion-dispatch-failed", conversionId)[0]).toMatchObject({
      level: "warn",
      attributes: { "exception.type": { value: "Error" } },
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "an account whose usage projection the registry refuses logs a warning on the alarm pass",
  async () => {
    const { account, accountId } = await createAccount();
    await account.failUsageProjectionsForTest();
    await account.adjustAllowance(
      crypto.randomUUID(),
      60_000,
      "conversion-outcome-test",
      Temporal.Now.instant().epochMilliseconds,
    );

    await account.reconcileForTest();

    const usageProjectionLogs = () =>
      stub
        .logs("cup-worker")
        .filter(
          (log) =>
            log.attributes["event.name"]?.value === "usage-projection-failed" &&
            log.attributes["cup.account.id"]?.value === accountId,
        );
    await stub.waitFor("the usage-projection-failed log", () => usageProjectionLogs().length > 0);
    expect(usageProjectionLogs()[0]).toMatchObject({
      level: "warn",
      attributes: { "exception.type": { value: "Error" } },
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a deleted conversion's Workflow instances that already finished log no termination warning",
  async () => {
    const { account, accountId } = await createAccount();
    await account.acceptPreparationForTest();
    const finishedConversionId = await startPreparedAccountConversion(account, accountId);
    const unreachableConversionId = await startPreparedAccountConversion(account, accountId);
    // As on the platform, terminating each of these finished instances throws.
    await account.reportWorkflowStatusForTest(finishedConversionId, "complete");
    await account.reportWorkflowStatusForTest(`segment-${finishedConversionId}-0`, "errored");
    await account.reportWorkflowStatusForTest(`segment-${finishedConversionId}-1`, "terminated");
    await account.deleteConversion(finishedConversionId);

    await account.reconcileForTest();

    // The unreachable conversion's instances report no status, so their failed terminations warn.
    // Its pass runs after the first one, so once its warnings arrive, the first pass's have too.
    await account.failTerminationsForTest();
    await account.deleteConversion(unreachableConversionId);
    await account.reconcileForTest();

    await waitForLogs("conversion-workflow-termination-failed", unreachableConversionId, 3);
    expect(logs("conversion-workflow-termination-failed", unreachableConversionId)).toHaveLength(3);
    expect(logs("conversion-workflow-termination-failed", finishedConversionId)).toEqual([]);
    expect(await account.terminationsForTest()).toEqual(
      expect.arrayContaining([
        finishedConversionId,
        `segment-${finishedConversionId}-0`,
        `segment-${finishedConversionId}-1`,
      ]),
    );
    expect(await account.getConversion(finishedConversionId)).toBeUndefined();
  },
  TEST_TIMEOUT_MS,
);

test(
  "a deleted conversion's Workflow instance that is still running and cannot be terminated logs a warning",
  async () => {
    const { account, accountId } = await createAccount();
    await account.acceptPreparationForTest();
    const conversionId = await startPreparedAccountConversion(account, accountId);
    for (const id of [conversionId, `segment-${conversionId}-0`, `segment-${conversionId}-1`]) {
      await account.reportWorkflowStatusForTest(id, "running");
    }
    await account.failTerminationsForTest();
    await account.deleteConversion(conversionId);

    await account.reconcileForTest();

    await waitForLogs("conversion-workflow-termination-failed", conversionId, 3);
    expect(
      logs("conversion-workflow-termination-failed", conversionId).map((log) => ({
        level: log.level,
        instanceId: log.attributes["cup.workflow_instance.id"]?.value,
        exceptionType: log.attributes["exception.type"]?.value,
      })),
    ).toEqual([
      { level: "warn", instanceId: conversionId, exceptionType: "Error" },
      { level: "warn", instanceId: `segment-${conversionId}-0`, exceptionType: "Error" },
      { level: "warn", instanceId: `segment-${conversionId}-1`, exceptionType: "Error" },
    ]);
  },
  TEST_TIMEOUT_MS,
);

async function createAccount() {
  const accountId = crypto.randomUUID();
  const account = bindings.SENTRY_ACCOUNTS.get(bindings.SENTRY_ACCOUNTS.idFromName(accountId));
  const nowMs = Temporal.Now.instant().epochMilliseconds;
  await account.initialize({ accountId, subject: crypto.randomUUID(), createdAtMs: nowMs });
  // Enough duration for the tests' two-segment narration documents.
  await account.adjustAllowance(crypto.randomUUID(), 3_600_000, "conversion-outcome-test", nowMs);
  return { account, accountId };
}

async function startAccountConversion(
  account: Awaited<ReturnType<typeof createAccount>>["account"],
  acceptedAtMs: number,
) {
  const started = await account.startConversion(
    { idempotencyKey: crypto.randomUUID(), sourceUrl: "https://example.com/outcome" },
    acceptedAtMs,
  );
  const conversionId = started.conversion?.conversionId;
  if (conversionId === undefined) {
    throw new Error("Expected an accepted conversion");
  }
  return conversionId;
}

async function startPreparedAccountConversion(
  account: Awaited<ReturnType<typeof createAccount>>["account"],
  accountId: string,
) {
  const nowMs = Temporal.Now.instant().epochMilliseconds;
  const conversionId = await startAccountConversion(account, nowMs);
  await account.settleConversion(
    conversionId,
    readyAccountOutcome(accountId, conversionId),
    nowMs,
    1,
    NARRATION_TEXT_CHARACTERS_BY_SEGMENT,
  );
  return conversionId;
}

async function createGrant() {
  const grantId = crypto.randomUUID();
  const grant = bindings.SENTRY_CONVERSION_GRANTS.get(
    bindings.SENTRY_CONVERSION_GRANTS.idFromName(grantId),
  );
  const nowMs = Temporal.Now.instant().epochMilliseconds;
  await grant.initialize(grantId, nowMs - 60 * MINUTE_MS, nowMs + 90 * 24 * 60 * MINUTE_MS);
  return { grant, grantId };
}

async function startGrantConversion(
  grant: Awaited<ReturnType<typeof createGrant>>["grant"],
  acceptedAtMs: number,
) {
  const started = await grant.startConversion(
    "https://example.com/outcome",
    crypto.randomUUID(),
    acceptedAtMs,
  );
  if (started.result !== "created") {
    throw new Error(`Expected an accepted conversion, got ${started.result}`);
  }
  return started.conversion.conversionId;
}

function readyGrantOutcome(conversionId: string) {
  return {
    title: "Book",
    audiobookReference: {
      key: `conversions/${conversionId}/audiobook.json`,
      contentType: "application/json" as const,
      byteLength: 42,
      etag: "fixture",
    },
  };
}

function readyAccountOutcome(accountId: string, conversionId: string) {
  return {
    status: "ready" as const,
    title: "Book",
    audiobookReference: {
      key: `accounts/${accountId}/conversions/${conversionId}/executions/1/audiobook.json`,
      contentType: "application/json" as const,
      byteLength: 123,
      etag: "fixture",
    },
  };
}

function failureEvents(conversionId: string): SentryErrorEvent[] {
  return stub
    .errorEvents("cup-worker")
    .filter(
      (event) =>
        event.tags?.["cup.conversion.id"] === conversionId &&
        event.tags["cup.conversion.failure_category"] !== undefined,
    );
}

function waitForFailureEvents(conversionId: string, count: number) {
  return stub.waitFor(
    `${count} failure event(s) of ${conversionId}`,
    () => failureEvents(conversionId).length >= count,
  );
}

function logs(eventName: string, conversionId: string): SentryLog[] {
  return stub
    .logs("cup-worker")
    .filter(
      (log) =>
        log.attributes["event.name"]?.value === eventName &&
        log.attributes["cup.conversion.id"]?.value === conversionId,
    );
}

function waitForLogs(eventName: string, conversionId: string, count: number) {
  return stub.waitFor(
    `${count} ${eventName} log(s) of ${conversionId}`,
    () => logs(eventName, conversionId).length >= count,
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
