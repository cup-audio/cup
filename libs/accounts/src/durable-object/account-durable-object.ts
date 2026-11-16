import { DurableObject } from "cloudflare:workers";
import { Temporal } from "temporal-polyfill";

import {
  assertSynthesisAttempts,
  type ConversionPhase,
  dispatchSegmentWorkflows,
  reconcileSegmentWorkflow,
  type SynthesisWorkflowDispatcher,
  type PlaybackPosition,
  createAccountArtifactPrefix,
  createConversionArtifactPrefix,
  createSegmentWorkflowId,
} from "@cup/conversion-contracts";
import { CupError } from "@cup/errors";
import {
  captureAlarmFailure,
  captureStoppedWorkflow,
  logAudioSegmentSettled,
  logEvent,
  logPreparationSettled,
  reportStuckConversionDeletions,
  reportStuckConversions,
  setConversionScope,
  withConversionScope,
} from "@cup/telemetry.cloudflare";
import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

import type {
  AccountConversionOutcome,
  AccountIdentity,
  AccountWorkflowParams,
} from "#src/domain/account-contracts.ts";
import type { AccountRegistry } from "#src/durable-object/account-registry.ts";
import { AccountArtifactWriters } from "#src/storage/account-artifact-writers.ts";
import { AccountLifecycle, AccountLifecycleConflictError } from "#src/storage/account-lifecycle.ts";
import { AccountSqlite } from "#src/storage/account-sqlite.ts";

const USAGE_PUBLICATION_RETRY_MS = 60_000;

/** Conversion deletion terminates the conversion's workflow instances. */
type TerminableWorkflow = {
  get(id: string): Promise<{ terminate(): Promise<void> }>;
};

type AccountEnvironment = {
  CONVERSION_OWNER_LIMIT: string;
  AUDIO_BUCKET: R2Bucket;
  REGISTRY: AccountRegistry;
  SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW: SynthesisWorkflowDispatcher & TerminableWorkflow;
  PREPARE_AUDIOBOOK_WORKFLOW: {
    create(input: { id: string; params: AccountWorkflowParams }): Promise<unknown>;
    get(id: string): Promise<{
      status(): Promise<{ status: string; error?: { message: string } }>;
      restart(): Promise<void>;
      terminate(): Promise<void>;
    }>;
  };
};

/** Internal account RPCs; the API must authenticate and resolve ownership before calling them. */
export class AccountDurableObject extends DurableObject<AccountEnvironment> {
  private readonly sqlite: AccountSqlite;
  private readonly artifactWriters: AccountArtifactWriters;
  private readonly lifecycle: AccountLifecycle;

  constructor(context: DurableObjectState, env: AccountEnvironment) {
    super(context, env);
    this.sqlite = new AccountSqlite(context.storage);
    void context.blockConcurrencyWhile(async () => {
      await this.sqlite.migrate();
      await this.armCleanupOfDeletedConversions();
    });
    this.artifactWriters = new AccountArtifactWriters(context.storage, () =>
      this.sqlite.snapshot(),
    );
    this.lifecycle = new AccountLifecycle(context.storage, () => this.sqlite.snapshot());
  }

  migrate() {
    return this.sqlite.migrate();
  }

  initialize(identity: AccountIdentity) {
    if (this.sqlite.isErased()) {
      throw new CupError("Account was erased");
    }
    return this.sqlite.initialize(identity);
  }

  inspect() {
    return this.sqlite.snapshot();
  }

  /** The registry pulls usage for accounts whose projection it lacks, such as new accounts. */
  registryUsageProjection() {
    return this.sqlite.usageProjection();
  }

  confirmRegistryUsage(revision: number) {
    this.sqlite.confirmRegistryUsage(revision);
  }

  async startConversion(
    input: { idempotencyKey: string; sourceUrl: string },
    nowMs = Temporal.Now.instant().epochMilliseconds,
  ) {
    await this.ctx.storage.setAlarm(Temporal.Now.instant().epochMilliseconds + 60_000);
    const result = this.sqlite.startConversion(
      input,
      nowMs,
      Number(this.env.CONVERSION_OWNER_LIMIT),
    );
    if (result.result !== "exhausted") {
      await this.reconcileDispatch();
    }
    return result;
  }

  /** A ready outcome with segment text lengths also reserves the whole narration document. */
  async settleConversion(
    conversionId: string,
    outcome: AccountConversionOutcome,
    nowMs = Temporal.Now.instant().epochMilliseconds,
    executionEpoch?: number,
    narrationTextCharactersBySegment?: readonly number[],
  ) {
    setConversionScope({ conversionId });
    // The alarm dispatches reserved segments if the workflow never gets to.
    if (narrationTextCharactersBySegment !== undefined) {
      await this.ctx.storage.setAlarm(Temporal.Now.instant().epochMilliseconds + 60_000);
    }
    this.settle(conversionId, outcome, nowMs, executionEpoch, narrationTextCharactersBySegment);
    await this.scheduleUsagePublication();
  }

  /** Records the outcome and sends `conversion-preparation-settled` unless it is a replay. */
  private settle(
    conversionId: string,
    outcome: AccountConversionOutcome,
    nowMs: number,
    executionEpoch?: number,
    narrationTextCharactersBySegment?: readonly number[],
  ) {
    const settlement = this.sqlite.settleConversion(
      conversionId,
      outcome,
      nowMs,
      executionEpoch,
      narrationTextCharactersBySegment,
    );
    if (settlement.result === "replayed") {
      return;
    }
    logPreparationSettled({
      ...(outcome.status === "failed"
        ? { outcome: "failed", failureCategory: outcome.failureCategory }
        : { outcome: settlement.isInsufficientDuration ? "insufficient-duration" : "ready" }),
      conversionId,
      conversionCreatedAtMs: settlement.conversionCreatedAtMs,
      settledAtMs: nowMs,
    });
  }

  /** `attempts` is how many synthesis attempts the segment's Workflow needed. */
  async completeAudioSegment(
    conversionId: string,
    sequence: number,
    durationMilliseconds: number,
    executionEpoch: number,
    attempts?: number,
  ) {
    setConversionScope({ conversionId });
    this.assertExecution(conversionId, executionEpoch);
    assertSynthesisAttempts(attempts);
    const settledAtMs = Temporal.Now.instant().epochMilliseconds;
    const result = this.sqlite.completeAudioSegment(
      conversionId,
      sequence,
      durationMilliseconds,
      settledAtMs,
    );
    if (result.result === "recorded") {
      this.logAudioSegmentSettled(conversionId, sequence, "settled", attempts, settledAtMs);
    }
    await this.scheduleUsagePublication();
    return result;
  }

  listAudioSegments(conversionId: string) {
    return this.sqlite.listAudioSegments(conversionId);
  }

  /** Operators list accounts right after adjusting them, so the projection is pushed at once. */
  async adjustAllowance(
    requestId: string,
    amount: number,
    cause: string,
    nowMs = Temporal.Now.instant().epochMilliseconds,
  ) {
    this.sqlite.adjustAllowance(requestId, amount, cause, nowMs);
    await this.publishRegistryUsage();
    await this.scheduleUsagePublication();
  }

  inspectAccounting() {
    return this.sqlite.inspectAccounting();
  }

  history(cursor?: { createdAtMs: number; conversionId: string }) {
    return this.sqlite.history(cursor);
  }

  getConversion(conversionId: string) {
    return this.sqlite.getConversion(conversionId);
  }

  assertExecution(conversionId: string, executionEpoch: number) {
    const account = this.sqlite.snapshot();
    if (
      account.state === "deleting" ||
      (account.state === "deletion_scheduled" &&
        (account.recoveryDeadlineMs === null ||
          Temporal.Now.instant().epochMilliseconds >= account.recoveryDeadlineMs)) ||
      account.executionEpoch !== executionEpoch ||
      !(["pending", "ready"] as const).some(
        (status) => status === this.sqlite.getConversion(conversionId)?.status,
      )
    ) {
      throw new CupError("Account execution is fenced");
    }
  }

  /**
   * Checks the execution and records the phase in one synchronous call, so a fenced execution
   * cannot record a phase between the check and the write.
   */
  recordPhaseStarted(conversionId: string, phase: ConversionPhase, executionEpoch: number) {
    setConversionScope({ conversionId });
    this.assertExecution(conversionId, executionEpoch);
    this.sqlite.recordPhaseStarted(conversionId, phase);
  }

  /** Reserves the whole narration document before dispatching any segment; see ADR 0008. */
  async startSynthesis(
    conversionId: string,
    narrationTextCharactersBySegment: readonly number[],
    executionEpoch: number,
  ) {
    setConversionScope({ conversionId });
    this.assertExecution(conversionId, executionEpoch);
    if (this.sqlite.getConversion(conversionId)?.status !== "ready") {
      throw new CupError("Narration is not prepared");
    }

    const reservation = this.sqlite.reserveMissingAudioSegments(
      conversionId,
      narrationTextCharactersBySegment,
      Temporal.Now.instant().epochMilliseconds,
    );
    if (reservation.result !== "reserved") {
      return reservation;
    }

    // The alarm completes a dispatch that fails partway.
    await this.ctx.storage.setAlarm(Temporal.Now.instant().epochMilliseconds + 60_000);
    // The gate keeps concurrent retries from restarting each other's instances. A throw inside it
    // would reset this object, so a dispatch failure is carried out of the gate first.
    const failure = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        await dispatchSegmentWorkflows(
          this.env.SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW,
          {
            v: 3,
            conversionId,
            owner: { kind: "account", accountId: this.sqlite.snapshot().accountId },
            executionEpoch,
          },
          reservation.sequences,
        );
        return undefined;
      } catch (error) {
        return { error };
      }
    });
    if (failure) {
      throw failure.error;
    }
    return { result: "started" as const };
  }

  /** `attempts` is how many synthesis attempts the segment's Workflow made before it failed. */
  async releaseAudioSegment(
    conversionId: string,
    sequence: number,
    executionEpoch: number,
    attempts?: number,
  ) {
    setConversionScope({ conversionId });
    this.assertExecution(conversionId, executionEpoch);
    assertSynthesisAttempts(attempts);
    this.release(conversionId, sequence, attempts);
    await this.scheduleUsagePublication();
  }

  /**
   * Releases the segment's reservation and sends `audio-segment-settled` if it had one; returns
   * whether it had one.
   */
  private release(conversionId: string, sequence: number, attempts: number | undefined) {
    const releasedAtMs = Temporal.Now.instant().epochMilliseconds;
    const isReleased = this.sqlite.releaseAudioSegment(conversionId, sequence, releasedAtMs);
    if (isReleased) {
      this.logAudioSegmentSettled(conversionId, sequence, "released", attempts, releasedAtMs);
    }
    return isReleased;
  }

  private logAudioSegmentSettled(
    conversionId: string,
    sequence: number,
    outcome: "settled" | "released",
    attempts: number | undefined,
    settledAtMs: number,
  ) {
    const conversion = this.sqlite.getConversion(conversionId);
    // A conversion marked for deletion reads as missing; its outcomes no longer matter, and the
    // record must not fail the settlement that already happened.
    if (conversion === undefined) {
      return;
    }
    logAudioSegmentSettled({
      conversionId,
      sequence,
      outcome,
      reservedAtMs: this.sqlite.audioSegmentReservedAtMs(conversionId, sequence),
      attempts,
      conversionCreatedAtMs: conversion.createdAtMs,
      segmentStates: this.sqlite.listAudioSegments(conversionId).map((segment) => segment.state),
      settledAtMs,
    });
  }

  /**
   * Deletes a conversion of an `active` or `deletion_scheduled` account: marks it, which fences it
   * like a missing row, and releases its open reservations in one transaction. A repeat while
   * marked changes nothing. Everything else, however many segments the conversion has, runs after
   * the response. See docs/architecture/conversion-deletion.md.
   */
  async deleteConversion(
    conversionId: string,
    nowMs = Temporal.Now.instant().epochMilliseconds,
  ): Promise<{ result: "marked" | "already-marked" | "not-found" | "account-unavailable" }> {
    setConversionScope({ conversionId });
    const marking = this.sqlite.markConversionDeletion(conversionId, nowMs);
    if (marking.result !== "marked") {
      return { result: marking.result };
    }

    // The alarm terminates the conversion's workflows, cleans it up, and also publishes the usage
    // the release changed.
    await this.ctx.storage.setAlarm(nowMs);
    return { result: "marked" };
  }

  private async terminateWorkflowsOfDeletedConversions() {
    for (const conversionId of this.sqlite.conversionsOwingWorkflowTermination()) {
      await withConversionScope({ conversionId, owner: this.owner() }, async () => {
        const segmentSequences = this.sqlite.claimWorkflowTermination(
          conversionId,
          Temporal.Now.instant().epochMilliseconds,
        );
        await this.terminateConversionWorkflows(conversionId, segmentSequences);
      });
    }
  }

  /** The owner every conversion of this account has, for the telemetry of an alarm iteration. */
  private owner() {
    return { kind: "account" as const, accountId: this.sqlite.snapshot().accountId };
  }

  /**
   * Termination only saves cost: the marker already fences whatever still runs, and a terminated
   * instance can still land its running step. Each instance is tried once, and a failure is only
   * logged, neither retried nor recorded.
   */
  private async terminateConversionWorkflows(
    conversionId: string,
    segmentSequences: readonly number[],
  ) {
    const segmentWorkflow: TerminableWorkflow = this.env.SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW;
    const instances = [
      { workflow: this.env.PREPARE_AUDIOBOOK_WORKFLOW, id: conversionId },
      ...segmentSequences.map((sequence) => ({
        workflow: segmentWorkflow,
        id: createSegmentWorkflowId(conversionId, sequence),
      })),
    ];

    for (const { workflow, id } of instances) {
      try {
        await (await workflow.get(id)).terminate();
      } catch (error) {
        logEvent(
          "conversion-workflow-termination-failed",
          "A deleted conversion's Workflow instance could not be terminated.",
          {
            attributes: {
              [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: conversionId,
              [TELEMETRY_ATTRIBUTES.WORKFLOW_INSTANCE_ID]: id,
            },
            error,
          },
        );
      }
    }
  }

  getPlaybackPosition(conversionId: string) {
    return this.sqlite.getPlaybackPosition(conversionId);
  }
  savePlaybackPosition(conversionId: string, position: PlaybackPosition) {
    this.sqlite.savePlaybackPosition(conversionId, position);
  }

  retryPreparation(conversionId: string) {
    setConversionScope({ conversionId });
    return this.ctx.blockConcurrencyWhile(async () => {
      const conversion = this.sqlite.getConversion(conversionId);
      if (conversion?.outcome?.status !== "failed") {
        return;
      }
      const account = this.sqlite.snapshot();
      const workflow = this.env.PREPARE_AUDIOBOOK_WORKFLOW;
      this.sqlite.retryPreparation(conversionId, Temporal.Now.instant().epochMilliseconds);
      try {
        try {
          await workflow.create({
            id: conversionId,
            params: {
              v: 2,
              sourceUrl: conversion.sourceUrl,
              owner: { kind: "account", accountId: account.accountId },
              conversionId,
              executionEpoch: account.executionEpoch,
            },
          });
        } catch {
          // Restart also covers the brief interval between recording failure and platform termination.
          const instance = await workflow.get(conversionId);
          await instance.restart();
        }
      } catch (error) {
        this.settle(conversionId, conversion.outcome, Temporal.Now.instant().epochMilliseconds);
        throw error;
      }
    });
  }

  override async alarm() {
    await this.reconcile(Temporal.Now.instant().epochMilliseconds);
  }

  /**
   * One alarm pass; only the stuck checks read `nowMs`, so tests can choose it. A step that throws
   * fails the pass, which captures the error and lets the platform retry the alarm.
   */
  protected async reconcile(nowMs: number) {
    await captureAlarmFailure(() => this.reconcilePass(nowMs));
  }

  private async reconcilePass(nowMs: number) {
    if (this.sqlite.isErased()) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // Re-arm before external calls: abrupt termination must not lose dispatch intent.
    await this.ctx.storage.setAlarm(Temporal.Now.instant().epochMilliseconds + 60_000);
    try {
      // Ahead of cleanup, which deletes the segment rows this reads, and of every step that can
      // throw.
      await this.terminateWorkflowsOfDeletedConversions();
      await this.reconcileArtifactWriters();
      await this.reconcileLifecycle();
      // Account erasure sweeps the whole account, so it subsumes any conversion cleanup still owed.
      if (this.sqlite.snapshot().state === "deleting") {
        return;
      }
      await this.cleanUpDeletedConversions();
      await this.reconcileDispatch();
      await this.reconcileSynthesis();
    } finally {
      // Also after a step that threw, so a failing step cannot hide a stuck case, and after the
      // cleanup, so a deletion that finished in this pass is not reported.
      if (this.sqlite.snapshot().state !== "deleting") {
        this.reportStuckConversionDeletions(nowMs);
        this.reportStuckConversions(nowMs);
      }
    }
    await this.publishRegistryUsage();
    if (
      this.sqlite.snapshot().state === "active" &&
      this.sqlite.conversionDeletions().length === 0 &&
      this.lifecycle.outbox().length === 0 &&
      this.sqlite.unsettledConversions().length === 0 &&
      this.sqlite.reservedAudioSegments().length === 0 &&
      this.artifactWriters.writers().length === 0 &&
      !this.sqlite.hasUnconfirmedUsage()
    ) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  /**
   * A conversion can be marked without an armed alarm, such as one marked before the alarm cleaned
   * up conversions or one whose deletion crashed before arming it.
   */
  private async armCleanupOfDeletedConversions() {
    if (
      this.sqlite.conversionDeletions().length > 0 &&
      (await this.ctx.storage.getAlarm()) === null
    ) {
      await this.ctx.storage.setAlarm(Temporal.Now.instant().epochMilliseconds);
    }
  }

  /**
   * Runs the idempotent cleanup steps of each marked conversion. A step that cannot finish leaves
   * the conversion marked, and the next alarm pass retries it from the start; one conversion's
   * failure never blocks another's. See docs/architecture/conversion-deletion.md.
   */
  private async cleanUpDeletedConversions() {
    for (const { conversionId } of this.sqlite.conversionDeletions()) {
      await withConversionScope({ conversionId, owner: this.owner() }, async () => {
        try {
          await this.cleanUpDeletedConversion(conversionId);
        } catch (error) {
          // The marked row stays, so the alarm stays armed and retries.
          logEvent(
            "conversion-deletion-cleanup-failed",
            "A pass of a deleted conversion's cleanup failed; the next alarm retries it.",
            { attributes: { [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: conversionId }, error },
          );
        }
      });
    }
  }

  private async cleanUpDeletedConversion(conversionId: string) {
    // The alarm already reconciled every writer; one still running may yet land a put.
    if (this.artifactWriters.hasUndrainedConversionWriters(conversionId)) {
      return;
    }

    const { accountId } = this.sqlite.snapshot();
    await this.deleteArtifactPrefix(
      createConversionArtifactPrefix(conversionId, { kind: "account", accountId }),
    );
    this.artifactWriters.removeDrainedConversionWriters(conversionId);

    const registry = this.env.REGISTRY;
    await registry.get(registry.idFromName("registry")).removeConversionOwner(conversionId);

    this.sqlite.deleteMarkedConversionRows(conversionId);
  }

  /** R2 has no prefix delete and deletes at most 1,000 keys per call. */
  private async deleteArtifactPrefix(prefix: string) {
    for (;;) {
      const objects = await this.env.AUDIO_BUCKET.list({ prefix, limit: 1000 });
      if (objects.objects.length === 0) {
        return;
      }
      await this.env.AUDIO_BUCKET.delete(objects.objects.map((object) => object.key));
    }
  }

  /**
   * Pushes the usage projection when the registry has not confirmed the current ledger revision.
   * The projection is derived from the ledger, so a failed push is safe to retry indefinitely.
   */
  private async publishRegistryUsage() {
    if (!this.sqlite.hasUnconfirmedUsage()) {
      return;
    }
    const projection = this.sqlite.usageProjection();
    try {
      const registry = this.env.REGISTRY;
      await registry.get(registry.idFromName("registry")).applyAccountUsageProjection(projection);
      this.sqlite.confirmRegistryUsage(projection.revision);
    } catch {
      /* The alarm retries until the registry confirms this or a later revision. */
    }
  }

  /** Arms the alarm, without postponing an earlier one, while the registry lags the ledger. */
  private async scheduleUsagePublication() {
    if (!this.sqlite.hasUnconfirmedUsage()) {
      return;
    }
    const publishAtMs = Temporal.Now.instant().epochMilliseconds + USAGE_PUBLICATION_RETRY_MS;
    const scheduledAtMs = await this.ctx.storage.getAlarm();
    if (scheduledAtMs === null || scheduledAtMs > publishAtMs) {
      await this.ctx.storage.setAlarm(publishAtMs);
    }
  }

  private async reconcileDispatch() {
    const workflow = this.env.PREPARE_AUDIOBOOK_WORKFLOW;
    const registry = this.env.REGISTRY;
    const account = this.sqlite.snapshot();
    for (const job of this.sqlite.unsettledConversions()) {
      await withConversionScope(
        { conversionId: job.conversionId, owner: this.owner() },
        async () => {
          try {
            this.assertExecution(job.conversionId, job.executionEpoch);
            if (job.state === "delivered") {
              const status = await (await workflow.get(job.conversionId)).status();
              if (status.status === "errored" || status.status === "terminated") {
                // The instance stopped without recording a failed outcome, so nothing captured it.
                captureStoppedWorkflow({ kind: "preparation", conversionId: job.conversionId });
                this.settle(
                  job.conversionId,
                  {
                    status: "failed",
                    failureCategory: "workflow-platform",
                    explanation: "The conversion could not be completed.",
                  },
                  Temporal.Now.instant().epochMilliseconds,
                  job.executionEpoch,
                );
              }
              return;
            }
            const conversion = this.sqlite.getConversion(job.conversionId);
            if (!conversion) {
              throw new CupError("Missing conversion dispatch target");
            }
            const registryStub = registry.get(registry.idFromName("registry"));
            await registryStub.bindConversionOwner(job.conversionId, {
              kind: "account",
              accountId: account.accountId,
            });

            // A deletion, even its whole cleanup, can land while the bind is in flight, so the bind may
            // have recreated an owner the cleanup already removed.
            if (!this.sqlite.getConversion(job.conversionId)) {
              await registryStub.removeConversionOwner(job.conversionId);
              return;
            }

            const params: AccountWorkflowParams = {
              v: 2,
              sourceUrl: conversion.sourceUrl,
              owner: { kind: "account", accountId: account.accountId },
              conversionId: job.conversionId,
              executionEpoch: job.executionEpoch,
            };
            try {
              await workflow.create({ id: job.conversionId, params });
            } catch {
              await (await workflow.get(job.conversionId)).status();
            }
            this.sqlite.markDispatched(job.conversionId);
          } catch (error) {
            // The persisted intent stays, so the alarm retries the dispatch.
            logEvent(
              "conversion-dispatch-failed",
              "A pass of a conversion's preparation dispatch failed; the next alarm retries it.",
              { attributes: { [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: job.conversionId }, error },
            );
          }
        },
      );
    }
  }

  /** Dispatches or resumes synthesis owed to reserved segments, and releases what cannot run. */
  private async reconcileSynthesis() {
    const account = this.sqlite.snapshot();
    for (const segment of this.sqlite.reservedAudioSegments()) {
      const context = {
        conversionId: segment.conversionId,
        owner: this.owner(),
        sequence: segment.sequence,
      };
      await withConversionScope(context, async () => {
        const result = await reconcileSegmentWorkflow(
          this.env.SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW,
          {
            v: 3,
            conversionId: segment.conversionId,
            owner: { kind: "account", accountId: account.accountId },
            executionEpoch: account.executionEpoch,
            sequence: segment.sequence,
          },
          { canResume: this.canExecute(segment.conversionId, account.executionEpoch) },
        );
        // The instance stopped without releasing the segment itself, so nothing captured it.
        if (
          result === "stopped" &&
          this.release(segment.conversionId, segment.sequence, undefined)
        ) {
          captureStoppedWorkflow({
            kind: "audio-segment",
            conversionId: segment.conversionId,
            sequence: segment.sequence,
          });
        }
      });
    }
  }

  /**
   * Sends one Sentry event per stuck conversion deletion; see
   * docs/architecture/conversion-deletion.md.
   */
  private reportStuckConversionDeletions(nowMs: number) {
    const reported = reportStuckConversionDeletions(
      this.sqlite.unreportedConversionDeletions(),
      nowMs,
    );
    for (const conversionId of reported) {
      this.sqlite.markDeletionStuckReported(conversionId, nowMs);
    }
  }

  /** Sends one Sentry event per stuck conversion and stage; see docs/architecture/conversion.md. */
  private reportStuckConversions(nowMs: number) {
    const reported = reportStuckConversions(
      this.sqlite.stuckConversionCandidates(),
      this.owner(),
      nowMs,
    );
    for (const conversionId of reported) {
      this.sqlite.markStuckReported(conversionId, nowMs);
    }
  }

  private canExecute(conversionId: string, executionEpoch: number) {
    try {
      this.assertExecution(conversionId, executionEpoch);
      return true;
    } catch {
      return false;
    }
  }

  async reconcileArtifactWriter(writerId: string) {
    const writer = this.artifactWriters.find(writerId);
    if (!writer) {
      return false;
    }
    if (writer.state === "drained") {
      return true;
    }
    if (writer.effect !== null) {
      if (!writer.effect.startsWith("put:")) {
        return false;
      }
      const object = await this.env.AUDIO_BUCKET.head(writer.effect.slice(4));
      if (object?.customMetadata?.["cup-writer-id"] !== writerId) {
        return false;
      }
      this.artifactWriters.writerEffect(writerId, null);
    }
    this.artifactWriters.drainWriter(writerId);
    return true;
  }
  private async reconcileArtifactWriters() {
    for (const writer of this.artifactWriters.writers()) {
      await this.reconcileArtifactWriter(writer.writerId);
    }
  }

  prepareArtifactWrite(writerId: string, executionEpoch: number, prefix: string, key: string) {
    this.artifactWriters.prepareWrite(writerId, executionEpoch, prefix, key);
  }

  registerArtifactWriter(writerId: string, executionEpoch: number, prefix: string) {
    this.artifactWriters.registerWriter(writerId, executionEpoch, prefix);
  }
  beginArtifactEffect(writerId: string, effect: string) {
    this.artifactWriters.writerEffect(writerId, effect);
  }
  acknowledgeArtifactEffect(writerId: string) {
    this.artifactWriters.writerEffect(writerId, null);
  }
  drainArtifactWriter(writerId: string) {
    this.artifactWriters.drainWriter(writerId);
  }

  deletionAttemptState(attemptId: string) {
    const attempt = this.lifecycle.current();
    return attempt?.attemptId === attemptId ? attempt.state : null;
  }
  deletionChallenge() {
    return this.lifecycle.challenge();
  }
  async scheduleDeletion(input: {
    challengeId: string;
    authenticatedAtSeconds: number;
    email: string;
  }) {
    await this.ctx.storage.setAlarm(Temporal.Now.instant().epochMilliseconds + 60_000);
    let attempt;
    try {
      attempt = this.lifecycle.schedule(input);
    } catch (error) {
      if (error instanceof AccountLifecycleConflictError) {
        return { result: "conflict" } as const;
      }
      throw error;
    }
    await this.reconcileLifecycle();
    return { result: "scheduled", attempt } as const;
  }
  async restoreAccount(challengeId: string, authenticatedAtSeconds: number) {
    await this.ctx.storage.setAlarm(Temporal.Now.instant().epochMilliseconds + 60_000);
    try {
      this.lifecycle.restore(challengeId, authenticatedAtSeconds);
    } catch (error) {
      if (error instanceof AccountLifecycleConflictError) {
        return { result: "conflict" } as const;
      }
      throw error;
    }
    await this.reconcileLifecycle();
    return { result: "restored", account: this.sqlite.snapshot() } as const;
  }
  private async reconcileLifecycle() {
    const registry = this.env.REGISTRY;
    for (const attempt of this.lifecycle.outbox()) {
      await registry.get(registry.idFromName("registry")).acceptDeletionAttempt(attempt);
      this.lifecycle.delivered(attempt.attemptId, attempt.state);
    }
    const attempt = this.lifecycle.current();
    if (
      attempt?.state === "scheduled" &&
      Temporal.Now.instant().epochMilliseconds >= attempt.deadlineMs
    ) {
      await registry.get(registry.idFromName("registry")).acceptDeletionAttempt(attempt);
      this.lifecycle.fence(attempt.attemptId);
    }
  }
  fenceDeletion(attemptId: string) {
    this.lifecycle.fence(attemptId);
  }
  async eraseAccount(attemptId: string) {
    if (this.sqlite.isErased()) {
      return;
    }
    const attempt = this.lifecycle.current();
    if (attempt?.attemptId !== attemptId || this.sqlite.snapshot().state !== "deleting") {
      throw new CupError("Account erasure is fenced");
    }
    if (this.artifactWriters.writers().length) {
      throw new CupError("Artifact writers have not drained");
    }
    await this.deleteArtifactPrefix(createAccountArtifactPrefix(attempt.accountId));
    await this.env.REGISTRY.get(
      this.env.REGISTRY.idFromName("registry"),
    ).removeAccountConversionOwners(attempt.accountId);
    this.sqlite.erase();
    await this.ctx.storage.deleteAlarm();
  }

  inspectArtifactWriters() {
    return this.artifactWriters.writers();
  }
  inspectConversionDeletions() {
    return this.sqlite.conversionDeletions();
  }
  pendingConversions() {
    return this.sqlite.pendingConversions();
  }
}
