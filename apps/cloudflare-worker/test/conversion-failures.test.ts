import { Temporal } from "temporal-polyfill";
import { test } from "vitest";

import { storeAudiobook } from "@cup/audiobook-production";
import { useSentryStub, type SentryStub } from "@cup/sentry-stub";

import { useWorker, type TestWorker } from "#test/use-worker.ts";

const SOURCE_URL = "https://example.com/conversion-failure";
const DAY_MS = 24 * 60 * 60 * 1_000;

async function createTrialConversion(worker: TestWorker) {
  const env = await worker.getEnv();
  const grantId = crypto.randomUUID();
  const grant = env.CONVERSION_GRANTS.get(env.CONVERSION_GRANTS.idFromName(grantId));
  const nowMs = Temporal.Now.instant().epochMilliseconds;
  await grant.initialize(grantId, nowMs, nowMs + DAY_MS);
  const started = await grant.startConversion(SOURCE_URL, crypto.randomUUID());
  if (started.result !== "created") {
    throw new Error(`Expected a created conversion, got ${started.result}`);
  }
  return { env, grant, grantId, conversionId: started.conversion.conversionId };
}

async function createPreparedTrialConversion(worker: TestWorker) {
  const conversion = await createTrialConversion(worker);
  const { env, grant, conversionId } = conversion;
  const narrationDocument = {
    html: '<article><h1 id="narration-unit-0001">A conversion with one segment</h1></article>',
    synchronizationUnits: [
      { id: "narration-unit-0001", narrationText: "A conversion with one segment" },
    ],
  };
  const audiobookReference = await storeAudiobook({
    bucket: env.AUDIO_BUCKET,
    conversionId,
    title: "A conversion with one segment",
    originalUrl: SOURCE_URL,
    narrationDocument,
  });
  await grant.recordReady(
    conversionId,
    { title: "A conversion with one segment", audiobookReference },
    narrationDocument.synchronizationUnits.map((unit) => unit.narrationText.length),
  );
  const manifest = await env.AUDIO_BUCKET.get(audiobookReference.key);
  return { ...conversion, manifestKey: audiobookReference.key, manifest: await manifest?.text() };
}

function segmentWorkflowParams(conversionId: string, grantId: string) {
  return {
    id: `segment-${conversionId}-0`,
    params: {
      v: 3 as const,
      conversionId,
      owner: { kind: "trial" as const, grantId },
      executionEpoch: 1,
      sequence: 0,
    },
  };
}

async function waitForStepSpan(
  sentry: SentryStub,
  stepName: string,
  options: { status?: string } = {},
): Promise<void> {
  await sentry.waitFor(`the span of the "${stepName}" step`, () =>
    sentry
      .spans("cup-worker")
      .some(
        (span) =>
          span.attributes["workflow.step.name"]?.value === stepName &&
          (options.status === undefined || span.status === options.status),
      ),
  );
}

test("a failed preparation sends one event, whose ID is the conversion's diagnostic reference", async ({
  expect,
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({ onTestFinished, sentryDsn: sentry.dsn("cup-worker") });
  const workflows = await worker.introspectWorkflow("PREPARE_AUDIOBOOK_WORKFLOW");
  onTestFinished(() => workflows.dispose());
  await workflows.modifyAll(async (modifier) => {
    await modifier.disableRetryDelays();
  });
  const { env, grant, grantId, conversionId } = await createTrialConversion(worker);

  await env.PREPARE_AUDIOBOOK_WORKFLOW.create({
    id: conversionId,
    params: { sourceUrl: SOURCE_URL, grantId },
  });

  await expect
    .poll(async () => (await grant.getConversion(conversionId))?.status, { timeout: 20_000 })
    .toBe("failed");
  await waitForStepSpan(sentry, "finalization: record conversion failure");
  const events = sentry.errorEvents("cup-worker");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    tags: {
      "cup.component": "prepare-audiobook-workflow",
      "cup.conversion.id": conversionId,
      "cup.conversion.failure_category": "source-preparation",
      "cup.owner.kind": "grant",
      "cup.conversion_grant.id": grantId,
    },
  });
  const conversion = await grant.getConversion(conversionId);
  expect(conversion?.status === "failed" && conversion.diagnosticReference).toBe(
    events[0]?.event_id,
  );
});

test("a preparation's steps are spans named after their conversion phases, and its owner logs the outcome", async ({
  expect,
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({ onTestFinished, sentryDsn: sentry.dsn("cup-worker") });
  const workflows = await worker.introspectWorkflow("PREPARE_AUDIOBOOK_WORKFLOW");
  onTestFinished(() => workflows.dispose());
  await workflows.modifyAll(async (modifier) => {
    await modifier.disableRetryDelays();
  });
  const { env, grantId, conversionId } = await createTrialConversion(worker);

  await env.PREPARE_AUDIOBOOK_WORKFLOW.create({
    id: conversionId,
    params: { sourceUrl: SOURCE_URL, grantId },
  });

  await waitForStepSpan(sentry, "finalization: record conversion failure");
  const stepSpanNames = sentry
    .spans("cup-worker")
    .filter((span) => span.attributes["workflow.step.name"] !== undefined)
    .map((span) => span.name);
  expect(new Set(stepSpanNames)).toEqual(
    new Set([
      "source-material-preparation: prepare audiobook source material",
      "finalization: create failed conversion outcome",
      "finalization: record conversion failure",
    ]),
  );
  await sentry.waitFor("the conversion-preparation-settled log", () =>
    sentry
      .logs("cup-worker")
      .some((log) => log.attributes["event.name"]?.value === "conversion-preparation-settled"),
  );
  expect(
    sentry
      .logs("cup-worker")
      .find((log) => log.attributes["event.name"]?.value === "conversion-preparation-settled"),
  ).toMatchObject({
    level: "info",
    attributes: {
      "cup.conversion.id": { value: conversionId },
      "cup.conversion.outcome": { value: "failed" },
      "cup.conversion.failure_category": { value: "source-preparation" },
    },
  });
});

test("a finally failed segment sends one event tagged segment", async ({
  expect,
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({ onTestFinished, sentryDsn: sentry.dsn("cup-worker") });
  const workflows = await worker.introspectWorkflow("SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW");
  onTestFinished(() => workflows.dispose());
  await workflows.modifyAll(async (modifier) => {
    await modifier.disableRetryDelays();
  });
  const { env, grant, grantId, conversionId } = await createPreparedTrialConversion(worker);

  await env.SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW.create(segmentWorkflowParams(conversionId, grantId));

  await expect
    .poll(async () => (await grant.listAudioSegments(conversionId))[0]?.state, {
      timeout: 20_000,
    })
    .toBe("released");
  await waitForStepSpan(sentry, "audio-segment-production: release failed segment reservation");
  const events = sentry.errorEvents("cup-worker");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    tags: {
      "cup.component": "synthesize-audio-segment-workflow",
      "cup.conversion.id": conversionId,
      "cup.conversion.failure_category": "segment",
      "cup.audio_segment.sequence": "0",
      "cup.owner.kind": "grant",
    },
  });
});

test("a segment whose prepared narration cannot be loaded is released and sends one event tagged segment", async ({
  expect,
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({ onTestFinished, sentryDsn: sentry.dsn("cup-worker") });
  const workflows = await worker.introspectWorkflow("SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW");
  onTestFinished(() => workflows.dispose());
  await workflows.modifyAll(async (modifier) => {
    await modifier.disableRetryDelays();
  });
  const { env, grant, grantId, conversionId, manifestKey } =
    await createPreparedTrialConversion(worker);

  await env.AUDIO_BUCKET.delete(manifestKey);
  await env.SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW.create(segmentWorkflowParams(conversionId, grantId));

  await expect
    .poll(async () => (await grant.listAudioSegments(conversionId))[0]?.state, {
      timeout: 20_000,
    })
    .toBe("released");
  await waitForStepSpan(sentry, "audio-segment-production: release failed segment reservation");
  const events = sentry.errorEvents("cup-worker");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    tags: {
      "cup.conversion.id": conversionId,
      "cup.conversion.failure_category": "segment",
      "cup.audio_segment.sequence": "0",
    },
  });
  expect(events[0]?.exception?.values).toEqual([
    expect.objectContaining({
      type: "Error",
      value: `Audiobook manifest was not found in storage: ${manifestKey}`,
      stacktrace: expect.anything(),
    }),
  ]);
});

test("a finally failed segment's owner logs its release with the run's attempts", async ({
  expect,
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({ onTestFinished, sentryDsn: sentry.dsn("cup-worker") });
  const workflows = await worker.introspectWorkflow("SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW");
  onTestFinished(() => workflows.dispose());
  await workflows.modifyAll(async (modifier) => {
    await modifier.disableRetryDelays();
  });
  const { env, grantId, conversionId } = await createPreparedTrialConversion(worker);

  await env.SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW.create(segmentWorkflowParams(conversionId, grantId));

  const findLog = (eventName: string) =>
    sentry.logs("cup-worker").find((log) => log.attributes["event.name"]?.value === eventName);
  await sentry.waitFor(
    "the conversion-synthesis-settled log",
    () => findLog("conversion-synthesis-settled") !== undefined,
    { timeoutMs: 20_000 },
  );
  expect(findLog("audio-segment-settled")).toMatchObject({
    attributes: {
      "cup.conversion.id": { value: conversionId },
      "cup.audio_segment.outcome": { value: "released" },
      "cup.audio_segment.attempts": { value: 3 },
    },
  });
  expect(findLog("conversion-synthesis-settled")).toMatchObject({
    attributes: {
      "cup.conversion.id": { value: conversionId },
      "cup.conversion.failed_segments": { value: 1 },
    },
  });
});

test("a preparation whose owner refuses its failed outcome is not captured by the run", async ({
  expect,
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({ onTestFinished, sentryDsn: sentry.dsn("cup-worker") });
  const workflows = await worker.introspectWorkflow("PREPARE_AUDIOBOOK_WORKFLOW");
  onTestFinished(() => workflows.dispose());
  await workflows.modifyAll(async (modifier) => {
    await modifier.disableRetryDelays();
  });
  const env = await worker.getEnv();
  const conversionId = crypto.randomUUID();

  await env.PREPARE_AUDIOBOOK_WORKFLOW.create({
    id: conversionId,
    params: { sourceUrl: SOURCE_URL, grantId: crypto.randomUUID() },
  });

  await waitForStepSpan(sentry, "finalization: create failed conversion outcome");
  expect(sentry.errorEvents("cup-worker")).toEqual([]);
});

test("a foreign error that failed a preparation step keeps its type and loses its message", async ({
  expect,
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({ onTestFinished, sentryDsn: sentry.dsn("cup-worker") });
  const workflows = await worker.introspectWorkflow("PREPARE_AUDIOBOOK_WORKFLOW");
  onTestFinished(() => workflows.dispose());
  await workflows.modifyAll(async (modifier) => {
    await modifier.disableRetryDelays();
  });
  const { env, grantId, conversionId } = await createTrialConversion(worker);

  await env.PREPARE_AUDIOBOOK_WORKFLOW.create({
    id: conversionId,
    params: { sourceUrl: SOURCE_URL, grantId },
  });

  await waitForStepSpan(sentry, "finalization: record conversion failure");
  const events = sentry.errorEvents("cup-worker");
  expect(events).toHaveLength(1);
  expect(events[0]?.exception?.values).toEqual([
    expect.objectContaining({ type: "TypeError", stacktrace: expect.anything() }),
  ]);
  expect(events[0]?.exception?.values?.[0]).not.toHaveProperty("value");
});

test("a retried Workflow step that then succeeds sends no error event", async ({
  expect,
  onTestFinished,
}) => {
  const sentry = await useSentryStub({ onTestFinished });
  const worker = await useWorker({ onTestFinished, sentryDsn: sentry.dsn("cup-worker") });
  const { env, grantId, conversionId, manifestKey, manifest } =
    await createPreparedTrialConversion(worker);
  const workflows = await worker.introspectWorkflow("SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW");
  onTestFinished(() => workflows.dispose());
  await workflows.modifyAll(async (modifier) => {
    await modifier.mockStepResult(
      { name: "audio-segment-production: synthesize and settle audio segment" },
      { result: "settled", segment: { durationMilliseconds: 1_000 } },
    );
  });

  await env.AUDIO_BUCKET.delete(manifestKey);
  await env.SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW.create(segmentWorkflowParams(conversionId, grantId));
  await waitForStepSpan(sentry, "audio-segment-production: load prepared narration", {
    status: "error",
  });
  await env.AUDIO_BUCKET.put(manifestKey, manifest ?? "", {
    httpMetadata: { contentType: "application/json" },
  });

  await waitForStepSpan(sentry, "audio-segment-production: load prepared narration", {
    status: "ok",
  });
  const instance = await env.SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW.get(`segment-${conversionId}-0`);
  await expect.poll(async () => (await instance.status()).status).toBe("complete");
  expect(sentry.errorEvents("cup-worker")).toEqual([]);
});
