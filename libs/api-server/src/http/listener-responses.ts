import type {
  AccountConversionOutcome,
  AccountHistoryPage,
  AccountSnapshot as StoredAccountSnapshot,
} from "@cup/accounts/contracts";
import type { AccountLifecycle } from "@cup/accounts/lifecycle";
import {
  ConversionPhase,
  layOutConsecutively,
  type DurationBalance,
  type PlaybackPosition,
} from "@cup/conversion-contracts";
import type { GrantSnapshot as StoredGrantSnapshot } from "@cup/conversion-grants/contracts";
import type {
  AccountHistory,
  AccountSnapshot,
  Audiobook,
  DeletionChallenge,
  GrantSnapshot,
  HistoryItem,
  PreparationPhase,
  SignInMethod,
} from "@cup/listener-api.routes";

type ReadyAudiobook = Extract<Audiobook, { status: "ready" }>;

export function toAccountSnapshotResponse(snapshot: StoredAccountSnapshot) {
  return {
    accountId: snapshot.accountId,
    subject: snapshot.subject,
    createdAtMs: snapshot.createdAtMs,
    state: snapshot.state,
    executionEpoch: snapshot.executionEpoch,
    recoveryDeadlineMs: snapshot.recoveryDeadlineMs,
    balance: {
      unit: snapshot.balance.unit,
      available: snapshot.balance.available,
      reserved: snapshot.balance.reserved,
    },
  } satisfies AccountSnapshot;
}

export function toDeletionChallengeResponse(
  challenge: ReturnType<AccountLifecycle["challenge"]>,
  acceptedMethods: SignInMethod[],
) {
  return {
    challengeId: challenge.challengeId,
    subject: challenge.subject,
    issuedAtMs: challenge.issuedAtMs,
    expiresAtMs: challenge.expiresAtMs,
    acceptedMethods,
  } satisfies DeletionChallenge;
}

export async function toAccountHistoryResponse(
  page: AccountHistoryPage,
  signCoverImageUrl: (conversionId: string) => Promise<string>,
): Promise<AccountHistory> {
  return {
    items: await Promise.all(
      page.items.map(async (item): Promise<HistoryItem> => ({
        conversionId: item.conversionId,
        idempotencyKey: item.idempotencyKey,
        sourceUrl: item.sourceUrl,
        createdAtMs: item.createdAtMs,
        status: item.status,
        ...(item.status === "pending" ? toPreparationPhaseField(item.lastStartedPhase) : {}),
        outcome: await toHistoryOutcome(item.outcome, () => signCoverImageUrl(item.conversionId)),
      })),
    ),
    nextCursor: page.nextCursor,
  } satisfies AccountHistory;
}

async function toHistoryOutcome(
  outcome: AccountConversionOutcome | null,
  signCoverImageUrl: () => Promise<string>,
): Promise<HistoryItem["outcome"]> {
  if (outcome === null) {
    return null;
  }
  if (outcome.status === "ready") {
    return {
      status: "ready",
      title: outcome.title,
      ...(outcome.hasCoverImage === undefined
        ? {}
        : {
            hasCoverImage: outcome.hasCoverImage,
            coverImage: { url: await signCoverImageUrl() },
          }),
    };
  }
  return { status: "failed", explanation: outcome.explanation };
}

const PREPARATION_PHASE_BY_CONVERSION_PHASE = {
  [ConversionPhase.CONVERSION_START]: "starting",
  [ConversionPhase.SOURCE_MATERIAL_PREPARATION]: "reading-page",
  [ConversionPhase.NARRATION_CONTENT_SELECTION]: "selecting-content",
  [ConversionPhase.NARRATION_DOCUMENT_CREATION]: "preparing-text",
  [ConversionPhase.AUDIO_SEGMENT_PRODUCTION]: undefined,
  [ConversionPhase.AUDIOBOOK_ASSEMBLY]: undefined,
  [ConversionPhase.AUDIOBOOK_STORAGE]: "preparing-text",
  [ConversionPhase.FINALIZATION]: "preparing-text",
} as const satisfies Record<ConversionPhase, PreparationPhase | undefined>;

export function toPreparationPhase(phase: ConversionPhase): PreparationPhase | undefined {
  return PREPARATION_PHASE_BY_CONVERSION_PHASE[phase];
}

export function toPreparationPhaseField(phase: ConversionPhase): {
  preparationPhase?: PreparationPhase;
} {
  const preparationPhase = toPreparationPhase(phase);
  return preparationPhase === undefined ? {} : { preparationPhase };
}

export function toGrantSnapshotResponse(snapshot: StoredGrantSnapshot) {
  return {
    grantId: snapshot.grantId,
    createdAt: snapshot.createdAt,
    expiresAt: snapshot.expiresAt,
    ...(snapshot.revokedAt === undefined ? {} : { revokedAt: snapshot.revokedAt }),
    state: snapshot.state,
    duration: toDurationBalanceResponse(snapshot.duration),
  } satisfies GrantSnapshot;
}

export function toDurationBalanceResponse(duration: DurationBalance) {
  return {
    availableMilliseconds: duration.availableMilliseconds,
    reservedMilliseconds: duration.reservedMilliseconds,
    spentMilliseconds: duration.spentMilliseconds,
  } satisfies GrantSnapshot["duration"];
}

export function toPlaybackPositionResponse(position: PlaybackPosition | null) {
  return position === null
    ? null
    : ({
        synchronizationUnitId: position.synchronizationUnitId,
        offsetMilliseconds: position.offsetMilliseconds,
      } satisfies ReadyAudiobook["playbackPosition"]);
}

export function toNarrationTrackResponse(
  url: string,
  durations: readonly number[],
  positionUrl?: string,
) {
  const { startOffsets, totalLength } = layOutConsecutively(durations);
  return {
    url,
    ...(positionUrl === undefined ? {} : { positionUrl }),
    durationMilliseconds: totalLength,
    startMilliseconds: startOffsets,
  } satisfies NonNullable<ReadyAudiobook["narrationTrack"]>;
}
