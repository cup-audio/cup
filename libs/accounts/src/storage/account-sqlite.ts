import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import {
  ConversionPhase,
  conversionPhaseSchema,
  playbackPositionSchema,
  type PlaybackPosition,
  createConversionArtifactPrefix,
  derivePreparedConversionStatus,
} from "@cup/conversion-contracts";
import { DurationLedger } from "@cup/duration-ledger";
import { CupError } from "@cup/errors";
import { RollingLimits } from "@cup/rolling-limits";

import {
  ACCOUNT_USAGE_PROJECTION_SCHEMA_VERSION,
  accountConversionDeletionSchema,
  accountIdentitySchema,
  accountOutcomeSchema,
  startAccountConversionSchema,
} from "#src/domain/account-contracts.ts";
import type {
  AccountAccountingInspection,
  AccountAllowanceAdjustmentResult,
  AccountLedgerPage,
  AccountConversion,
  AccountConversionDeletion,
  AccountConversionOutcome,
  AccountHistoryPage,
  AccountIdentity,
  AccountSnapshot,
  AccountUsageProjection,
} from "#src/domain/account-contracts.ts";
import { canonicalJson } from "#src/encoding.ts";
import {
  accountPlaybackPositions,
  accounts,
  accountConversions,
  pendingJobs,
  audioSegments,
  artifactWriters,
  creditBalances,
  creditLedger,
  creditOperations,
  deletionChallenges,
  deletionAttempts,
  accountTombstone,
} from "#src/storage/account-sqlite-schema.ts";
import { rateEvents } from "#src/storage/rate-limit-schema.ts";
import { migrateAccount } from "#src/storage/sqlite-migrations.ts";
import { requireRow } from "#src/storage/sqlite-row.ts";

type ConversionStageProgress = {
  conversionId: string;
  status: "pending" | "ready" | "failed";
  lastStartedPhase: ConversionPhase;
  hasReservedSegment: boolean;
  stageStartedAtMs: number;
};

const WELCOME_ALLOWANCE_MILLISECONDS = 30 * 60 * 1_000;

export class AccountSqlite {
  private readonly database: DrizzleSqliteDODatabase;
  private readonly limits: RollingLimits;
  private readonly duration: DurationLedger;

  constructor(storage: DurableObjectStorage) {
    this.database = drizzle(storage);
    this.limits = new RollingLimits(storage);
    this.duration = new DurationLedger(storage, audioSegments);
  }

  migrate(): Promise<void> {
    return migrateAccount(this.database);
  }

  isErased(): boolean {
    return (
      this.database.select({ id: accountTombstone.id }).from(accountTombstone).limit(1).get() !==
      undefined
    );
  }

  erase(): void {
    this.database.transaction(() => {
      for (const table of [
        accountPlaybackPositions,
        artifactWriters,
        pendingJobs,
        audioSegments,
        accountConversions,
        creditLedger,
        creditOperations,
        creditBalances,
        rateEvents,
        deletionChallenges,
        deletionAttempts,
        accounts,
      ]) {
        this.database.delete(table).run();
      }
      this.database.insert(accountTombstone).values({ id: 1, attemptId: "" }).run();
    });
  }

  initialize(identity: AccountIdentity): AccountSnapshot {
    const input = accountIdentitySchema.parse(identity);
    return this.database.transaction(() => {
      const existing = this.readIdentity();
      if (existing !== undefined) {
        if (
          canonicalJson(input) !==
          canonicalJson({
            accountId: existing.accountId,
            subject: existing.subject,
            createdAtMs: existing.createdAtMs,
          })
        ) {
          throw new CupError("Account initialization conflicts with its existing identity");
        }
        return this.snapshot();
      }
      this.database
        .insert(accounts)
        .values({
          id: 1,
          accountId: input.accountId,
          subject: input.subject,
          createdAtMs: input.createdAtMs,
          state: "active",
          executionEpoch: 1,
        })
        .run();
      this.duration.initialize(
        `welcome:${input.accountId}:v1`,
        WELCOME_ALLOWANCE_MILLISECONDS,
        "welcome-v1",
        input.createdAtMs,
      );
      return this.snapshot();
    });
  }

  snapshot(): AccountSnapshot {
    const identity = this.readIdentity();
    if (identity === undefined) {
      throw new CupError("Account is not initialized");
    }
    return { ...identity, balance: { unit: "audio-millisecond", ...this.duration.balance() } };
  }

  usageProjection(): AccountUsageProjection {
    const { accountId } = this.snapshot();
    const totals = this.duration.totals();
    return {
      accountId,
      revision: this.duration.revision(),
      allowanceMilliseconds: totals.allowanceMilliseconds,
      reservedMilliseconds: totals.reservedMilliseconds,
      spentMilliseconds: totals.spentMilliseconds,
      schemaVersion: ACCOUNT_USAGE_PROJECTION_SCHEMA_VERSION,
    };
  }

  hasUnconfirmedUsage(): boolean {
    const confirmed = this.database
      .select({ revision: accounts.registryConfirmedRevision })
      .from(accounts)
      .where(eq(accounts.id, 1))
      .get();
    return confirmed !== undefined && confirmed.revision < this.duration.revision();
  }

  confirmRegistryUsage(revision: number): void {
    z.number().int().nonnegative().safe().parse(revision);
    this.database
      .update(accounts)
      .set({
        registryConfirmedRevision: sql`max(${accounts.registryConfirmedRevision}, ${revision})`,
      })
      .where(eq(accounts.id, 1))
      .run();
  }

  startConversion(
    input: { idempotencyKey: string; sourceUrl: string },
    nowMs: number,
    startLimit: number,
  ): {
    result: "created" | "replayed" | "exhausted" | "rate-limited";
    conversion?: AccountConversion;
    retryAfter?: number;
  } {
    z.number().int().nonnegative().safe().parse(nowMs);
    const request = startAccountConversionSchema.parse(input);
    return this.database.transaction(() => {
      const account = this.requireActive();
      const existing = this.database
        .select({
          conversionId: accountConversions.conversionId,
          idempotencyKey: accountConversions.idempotencyKey,
          sourceUrl: accountConversions.sourceUrl,
          createdAtMs: accountConversions.createdAtMs,
          status: accountConversions.status,
          lastStartedPhase: accountConversions.lastStartedPhase,
        })
        .from(accountConversions)
        .where(eq(accountConversions.idempotencyKey, request.idempotencyKey))
        .get();
      if (existing !== undefined) {
        if (existing.sourceUrl !== request.sourceUrl) {
          throw new CupError("Conversion idempotency conflict");
        }
        return { result: "replayed", conversion: existing };
      }
      const retryAfter = this.limits.consume("account-conversion", startLimit, 60_000, nowMs);
      if (retryAfter) {
        return { result: "rate-limited", retryAfter };
      }
      const conversionId = crypto.randomUUID();
      this.database
        .insert(accountConversions)
        .values({
          conversionId,
          idempotencyKey: request.idempotencyKey,
          sourceUrl: request.sourceUrl,
          createdAtMs: nowMs,
          status: "pending",
          lastStartedPhase: ConversionPhase.CONVERSION_START,
          stageStartedAtMs: nowMs,
        })
        .run();
      this.database
        .insert(pendingJobs)
        .values({
          jobId: `conversion:${conversionId}`,
          conversionId,
          executionEpoch: account.executionEpoch,
          state: "pending",
        })
        .run();
      return {
        result: "created",
        conversion: {
          conversionId,
          ...request,
          createdAtMs: nowMs,
          status: "pending",
          lastStartedPhase: ConversionPhase.CONVERSION_START,
        },
      };
    });
  }

  reserveMissingAudioSegments(
    conversionId: string,
    narrationTextCharactersBySegment: readonly number[],
    nowMs: number,
  ) {
    return this.database.transaction(() => {
      const reservation = this.duration.reserveMissing(
        conversionId,
        narrationTextCharactersBySegment,
        nowMs,
      );
      if (reservation.result === "reserved" && reservation.hasChanged) {
        this.startStage(conversionId, nowMs);
      }
      return reservation;
    });
  }

  reservedAudioSegments() {
    return this.duration.reservedSegments();
  }

  completeAudioSegment(
    conversionId: string,
    sequence: number,
    durationMilliseconds: number,
    nowMs: number,
  ) {
    return this.duration.complete(conversionId, sequence, durationMilliseconds, nowMs);
  }

  retryPreparation(conversionId: string, nowMs: number) {
    this.requireActive();
    this.database
      .update(accountConversions)
      .set({
        status: "pending",
        lastStartedPhase: ConversionPhase.CONVERSION_START,
        completedAtMs: null,
        ...EMPTY_OUTCOME_COLUMNS,
        stageStartedAtMs: nowMs,
        stuckReportedAtMs: null,
      })
      .where(
        and(
          eq(accountConversions.conversionId, conversionId),
          eq(accountConversions.status, "failed"),
        ),
      )
      .run();
  }

  recordPhaseStarted(conversionId: string, phase: ConversionPhase) {
    const parsed = conversionPhaseSchema.parse(phase);
    this.database
      .update(accountConversions)
      .set({ lastStartedPhase: parsed })
      .where(
        and(
          eq(accountConversions.conversionId, conversionId),
          eq(accountConversions.status, "pending"),
        ),
      )
      .run();
  }

  releaseAudioSegment(conversionId: string, sequence: number, nowMs: number): boolean {
    return this.duration.releaseReservations(conversionId, nowMs, sequence) > 0;
  }

  audioSegmentReservedAtMs(conversionId: string, sequence: number): number | undefined {
    return this.duration.reservedAtMs(conversionId, sequence);
  }

  getPlaybackPosition(conversionId: string): PlaybackPosition | null {
    this.requireActive();
    if (this.isMarkedForDeletion(conversionId)) {
      return null;
    }
    const row = this.database
      .select()
      .from(accountPlaybackPositions)
      .where(eq(accountPlaybackPositions.conversionId, conversionId))
      .get();
    return row
      ? {
          synchronizationUnitId: row.synchronizationUnitId,
          offsetMilliseconds: row.offsetMilliseconds,
        }
      : null;
  }

  savePlaybackPosition(conversionId: string, position: PlaybackPosition) {
    this.requireActive();
    if (this.isMarkedForDeletion(conversionId)) {
      throw new CupError("Account conversion does not exist");
    }
    const parsed = playbackPositionSchema.parse(position);
    this.database
      .insert(accountPlaybackPositions)
      .values({
        conversionId,
        ...parsed,
        offsetMilliseconds: Math.round(parsed.offsetMilliseconds),
      })
      .onConflictDoUpdate({
        target: accountPlaybackPositions.conversionId,
        set: { ...parsed, offsetMilliseconds: Math.round(parsed.offsetMilliseconds) },
      })
      .run();
  }

  listAudioSegments(conversionId: string) {
    if (this.isMarkedForDeletion(conversionId)) {
      return [];
    }
    return this.duration.segments(conversionId);
  }

  markConversionDeletion(
    conversionId: string,
    nowMs: number,
  ): { result: "marked" | "already-marked" | "not-found" | "account-unavailable" } {
    z.number().int().nonnegative().safe().parse(nowMs);
    return this.database.transaction(() => {
      if (this.snapshot().state === "deleting") {
        return { result: "account-unavailable" };
      }

      const row = this.readDeletionMarker(conversionId);
      if (row === undefined) {
        return { result: "not-found" };
      }
      if (row.deletingSinceMs !== null) {
        return { result: "already-marked" };
      }

      this.database
        .update(accountConversions)
        .set({ deletingSinceMs: nowMs })
        .where(eq(accountConversions.conversionId, conversionId))
        .run();
      this.duration.releaseReservations(conversionId, nowMs);
      return { result: "marked" };
    });
  }

  conversionsOwingWorkflowTermination(): string[] {
    return this.database
      .select({ conversionId: accountConversions.conversionId })
      .from(accountConversions)
      .where(
        and(
          isNotNull(accountConversions.deletingSinceMs),
          isNull(accountConversions.workflowTerminationTriedAtMs),
        ),
      )
      .all()
      .map((row) => row.conversionId);
  }

  claimWorkflowTermination(conversionId: string, nowMs: number): number[] {
    z.number().int().nonnegative().safe().parse(nowMs);
    this.database
      .update(accountConversions)
      .set({ workflowTerminationTriedAtMs: nowMs })
      .where(eq(accountConversions.conversionId, conversionId))
      .run();
    return this.duration.segments(conversionId).map((segment) => segment.sequence);
  }

  deleteMarkedConversionRows(conversionId: string): void {
    this.database.transaction(() => {
      if (!this.isMarkedForDeletion(conversionId)) {
        return;
      }
      this.database.delete(audioSegments).where(eq(audioSegments.conversionId, conversionId)).run();
      this.database
        .delete(accountPlaybackPositions)
        .where(eq(accountPlaybackPositions.conversionId, conversionId))
        .run();
      this.database.delete(pendingJobs).where(eq(pendingJobs.conversionId, conversionId)).run();
      this.database
        .delete(accountConversions)
        .where(eq(accountConversions.conversionId, conversionId))
        .run();
    });
  }

  settleConversion(
    conversionId: string,
    outcome: AccountConversionOutcome,
    nowMs: number,
    executionEpoch?: number,
    narrationTextCharactersBySegment?: readonly number[],
  ):
    | { result: "recorded"; conversionCreatedAtMs: number; isInsufficientDuration: boolean }
    | { result: "replayed" } {
    z.number().int().nonnegative().safe().parse(nowMs);
    z.uuidv4().parse(conversionId);
    const parsed = accountOutcomeSchema.parse(outcome);
    return this.database.transaction(() => {
      const account = this.snapshot();
      if (executionEpoch !== undefined && account.executionEpoch !== executionEpoch) {
        throw new CupError("Account execution epoch mismatch");
      }
      const deadline = requireRow(
        this.database
          .select({ deadline: accounts.recoveryDeadlineMs })
          .from(accounts)
          .where(eq(accounts.id, 1))
          .get(),
      ).deadline;
      if (
        account.state === "deleting" ||
        (account.state === "deletion_scheduled" && (deadline === null || nowMs >= deadline))
      ) {
        throw new CupError("Account blocks conversion settlement");
      }
      const conversion = this.getConversion(conversionId);
      if (conversion === undefined) {
        throw new CupError("Account conversion does not exist");
      }
      if (conversion.status !== "pending") {
        if (canonicalJson(conversion.outcome) !== canonicalJson(parsed)) {
          throw new CupError("Conflicting conversion settlement");
        }
        return { result: "replayed" as const };
      }
      if (
        parsed.status === "ready" &&
        !parsed.audiobookReference.key.startsWith(
          createConversionArtifactPrefix(conversionId, {
            kind: "account",
            accountId: account.accountId,
          }),
        )
      ) {
        throw new CupError("Private audiobook reference is outside its conversion prefix");
      }
      this.database
        .update(accountConversions)
        .set({ status: parsed.status, completedAtMs: nowMs, ...toOutcomeColumns(parsed) })
        .where(eq(accountConversions.conversionId, conversionId))
        .run();
      this.duration.releaseReservations(conversionId, nowMs);
      let isInsufficientDuration = false;
      if (parsed.status === "ready" && narrationTextCharactersBySegment !== undefined) {
        const reservation = this.duration.reserveMissing(
          conversionId,
          narrationTextCharactersBySegment,
          nowMs,
        );
        isInsufficientDuration = reservation.result !== "reserved";
        if (reservation.result === "reserved" && reservation.hasChanged) {
          this.startStage(conversionId, nowMs);
        }
      }
      this.database
        .update(pendingJobs)
        .set({ state: "delivered" })
        .where(eq(pendingJobs.conversionId, conversionId))
        .run();
      return {
        result: "recorded" as const,
        conversionCreatedAtMs: conversion.createdAtMs,
        isInsufficientDuration,
      };
    });
  }

  adjustAllowance(
    requestId: string,
    amount: number,
    cause: string,
    nowMs: number,
  ): AccountAllowanceAdjustmentResult {
    const identity = this.readIdentity();
    if (identity === undefined) {
      return { result: "account-not-initialized" };
    }
    if (identity.state !== "active") {
      return { result: "account-not-active" };
    }
    return this.duration.adjustAllowance(requestId, amount, cause, nowMs);
  }

  inspectAccounting(): AccountAccountingInspection {
    const accounting = this.duration.inspectAccounting();
    return {
      ...accounting,
      balance: { unit: "audio-millisecond", ...accounting.balance },
    };
  }

  ledger(page: { limit: number; cursor?: string }): AccountLedgerPage {
    this.snapshot();
    let afterPosition: number | undefined;
    if (page.cursor !== undefined) {
      afterPosition = Number(page.cursor);
      if (!/^[1-9]\d*$/.test(page.cursor) || !Number.isSafeInteger(afterPosition)) {
        throw new CupError("Invalid ledger cursor");
      }
    }
    const { entries, nextPosition } = this.duration.entries({
      limit: page.limit,
      ...(afterPosition === undefined ? {} : { afterPosition }),
    });
    return {
      unit: "audio-millisecond",
      entries,
      nextCursor: nextPosition === undefined ? null : String(nextPosition),
    };
  }

  unsettledConversions(): {
    conversionId: string;
    executionEpoch: number;
    state: "pending" | "delivered";
  }[] {
    return this.database
      .select({
        conversionId: pendingJobs.conversionId,
        executionEpoch: pendingJobs.executionEpoch,
        state: pendingJobs.state,
      })
      .from(pendingJobs)
      .innerJoin(accountConversions, eq(pendingJobs.conversionId, accountConversions.conversionId))
      .where(eq(accountConversions.status, "pending"))
      .all();
  }

  pendingConversions(): { conversionId: string; executionEpoch: number }[] {
    return this.database
      .select({
        conversionId: pendingJobs.conversionId,
        executionEpoch: pendingJobs.executionEpoch,
      })
      .from(pendingJobs)
      .where(eq(pendingJobs.state, "pending"))
      .all();
  }

  history(cursor?: { createdAtMs: number; conversionId: string }): AccountHistoryPage {
    const rows = this.database
      .select({
        conversionId: accountConversions.conversionId,
        createdAtMs: accountConversions.createdAtMs,
      })
      .from(accountConversions)
      .where(
        and(
          isNull(accountConversions.deletingSinceMs),
          cursor
            ? or(
                lt(accountConversions.createdAtMs, cursor.createdAtMs),
                and(
                  eq(accountConversions.createdAtMs, cursor.createdAtMs),
                  lt(accountConversions.conversionId, cursor.conversionId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(accountConversions.createdAtMs), desc(accountConversions.conversionId))
      .limit(51)
      .all();
    const items = rows.slice(0, 50).map((row) => {
      const conversion = requireRow(this.getConversion(row.conversionId));
      return conversion.status === "ready"
        ? {
            ...conversion,
            status: derivePreparedConversionStatus(this.duration.segments(row.conversionId)),
          }
        : conversion;
    });
    const last = rows[49];
    return {
      items,
      nextCursor: rows.length > 50 && last ? `${last.createdAtMs}:${last.conversionId}` : null,
    };
  }

  conversionDeletions(): AccountConversionDeletion[] {
    return this.database
      .select({
        conversionId: accountConversions.conversionId,
        deletingSinceMs: accountConversions.deletingSinceMs,
      })
      .from(accountConversions)
      .where(isNotNull(accountConversions.deletingSinceMs))
      .orderBy(accountConversions.deletingSinceMs, accountConversions.conversionId)
      .all()
      .map((row) => accountConversionDeletionSchema.parse(row));
  }

  unreportedConversionDeletions(): AccountConversionDeletion[] {
    return this.database
      .select({
        conversionId: accountConversions.conversionId,
        deletingSinceMs: accountConversions.deletingSinceMs,
      })
      .from(accountConversions)
      .where(
        and(
          isNotNull(accountConversions.deletingSinceMs),
          isNull(accountConversions.deletionStuckReportedAtMs),
        ),
      )
      .orderBy(accountConversions.deletingSinceMs, accountConversions.conversionId)
      .all()
      .map((row) => accountConversionDeletionSchema.parse(row));
  }

  markDeletionStuckReported(conversionId: string, nowMs: number): void {
    this.database
      .update(accountConversions)
      .set({ deletionStuckReportedAtMs: nowMs })
      .where(eq(accountConversions.conversionId, conversionId))
      .run();
  }

  getConversion(conversionId: string):
    | (AccountConversion & {
        outcome: AccountConversionOutcome | null;
        completedAtMs: number | null;
      })
    | undefined {
    const row = this.database
      .select()
      .from(accountConversions)
      .where(
        and(
          eq(accountConversions.conversionId, conversionId),
          isNull(accountConversions.deletingSinceMs),
        ),
      )
      .get();
    if (!row) {
      return undefined;
    }
    return {
      conversionId: row.conversionId,
      idempotencyKey: row.idempotencyKey,
      sourceUrl: row.sourceUrl,
      createdAtMs: row.createdAtMs,
      status: row.status,
      lastStartedPhase: row.lastStartedPhase,
      completedAtMs: row.completedAtMs,
      outcome: toOutcome(row),
    };
  }

  conversionsWithUnreportedStage(): ConversionStageProgress[] {
    const reservedConversionIds = new Set(
      this.duration.reservedSegments().map((segment) => segment.conversionId),
    );
    return this.database
      .select({
        conversionId: accountConversions.conversionId,
        status: accountConversions.status,
        lastStartedPhase: accountConversions.lastStartedPhase,
        stageStartedAtMs: accountConversions.stageStartedAtMs,
        createdAtMs: accountConversions.createdAtMs,
        completedAtMs: accountConversions.completedAtMs,
      })
      .from(accountConversions)
      .where(
        and(
          isNull(accountConversions.deletingSinceMs),
          isNull(accountConversions.stuckReportedAtMs),
        ),
      )
      .all()
      .map((row) => ({
        conversionId: row.conversionId,
        status: row.status,
        lastStartedPhase: row.lastStartedPhase,
        hasReservedSegment: reservedConversionIds.has(row.conversionId),
        stageStartedAtMs: row.stageStartedAtMs ?? row.completedAtMs ?? row.createdAtMs,
      }));
  }

  markStuckReported(conversionId: string, nowMs: number): void {
    this.database
      .update(accountConversions)
      .set({ stuckReportedAtMs: nowMs })
      .where(eq(accountConversions.conversionId, conversionId))
      .run();
  }

  markDispatched(conversionId: string): void {
    this.database
      .update(pendingJobs)
      .set({ state: "delivered" })
      .where(eq(pendingJobs.conversionId, conversionId))
      .run();
  }

  private startStage(conversionId: string, nowMs: number): void {
    this.database
      .update(accountConversions)
      .set({ stageStartedAtMs: nowMs, stuckReportedAtMs: null })
      .where(eq(accountConversions.conversionId, conversionId))
      .run();
  }

  private isMarkedForDeletion(conversionId: string): boolean {
    return (this.readDeletionMarker(conversionId)?.deletingSinceMs ?? null) !== null;
  }

  private readDeletionMarker(conversionId: string) {
    return this.database
      .select({ deletingSinceMs: accountConversions.deletingSinceMs })
      .from(accountConversions)
      .where(eq(accountConversions.conversionId, conversionId))
      .get();
  }

  private readIdentity(): Omit<AccountSnapshot, "balance"> | undefined {
    return this.database
      .select({
        accountId: accounts.accountId,
        subject: accounts.subject,
        createdAtMs: accounts.createdAtMs,
        state: accounts.state,
        executionEpoch: accounts.executionEpoch,
        recoveryDeadlineMs: accounts.recoveryDeadlineMs,
      })
      .from(accounts)
      .where(eq(accounts.id, 1))
      .get();
  }

  private requireActive(): AccountSnapshot {
    const account = this.snapshot();
    if (account.state !== "active") {
      throw new CupError("Account is not active");
    }
    return account;
  }
}

type ConversionRow = typeof accountConversions.$inferSelect;
type OutcomeColumns = Pick<
  ConversionRow,
  | "title"
  | "audiobookReference"
  | "hasCoverImage"
  | "narrationLanguage"
  | "failureCategory"
  | "explanation"
>;

const EMPTY_OUTCOME_COLUMNS = {
  title: null,
  audiobookReference: null,
  hasCoverImage: null,
  narrationLanguage: null,
  failureCategory: null,
  explanation: null,
} satisfies OutcomeColumns;

function toOutcomeColumns(outcome: AccountConversionOutcome): OutcomeColumns {
  if (outcome.status === "ready") {
    return {
      ...EMPTY_OUTCOME_COLUMNS,
      title: outcome.title,
      audiobookReference: outcome.audiobookReference,
      hasCoverImage: outcome.hasCoverImage ?? null,
      narrationLanguage: outcome.narrationLanguage ?? null,
    };
  }
  return {
    ...EMPTY_OUTCOME_COLUMNS,
    failureCategory: outcome.failureCategory,
    explanation: outcome.explanation,
  };
}

function toOutcome(row: ConversionRow): AccountConversionOutcome | null {
  if (row.status === "pending") {
    return null;
  }
  return accountOutcomeSchema.parse(
    row.status === "ready"
      ? {
          status: "ready",
          title: row.title,
          audiobookReference: row.audiobookReference,
          ...(row.hasCoverImage === true ? { hasCoverImage: true } : {}),
          ...(row.narrationLanguage === null ? {} : { narrationLanguage: row.narrationLanguage }),
        }
      : { status: "failed", failureCategory: row.failureCategory, explanation: row.explanation },
  );
}
