import { createActor, type Actor } from "xstate";

import type { Audiobook, NarrationTrack, PlaybackPosition } from "@cup/listener-api.routes";

import { findUnitIndexAt, type AudiobookTimeline } from "#src/app/player/audiobook-timeline.ts";
import {
  positionSavesMachine,
  type PositionSaveServices,
  type PositionSavesMachineSnapshot,
} from "#src/app/player/position-saves-machine.ts";

export {
  SAVE_RETRY_DELAY_MILLISECONDS,
  SAVE_RETRY_FAILURE_MESSAGE,
} from "#src/app/player/position-saves-machine.ts";

/** A conversion whose narration document is prepared, whatever the state of its audio. */
export type PreparedAudiobook = Extract<
  Audiobook,
  { status: "insufficient-duration" | "synthesizing" | "ready" }
>;
/** An audiobook with a narration track: every segment has audio. */
export type PlayableAudiobook = Extract<Audiobook, { status: "ready" }> & {
  narrationTrack: NarrationTrack;
};

export type PlaybackSessionRequest = {
  conversionId: string;
  audiobook: PlayableAudiobook;
  /** The listening position to restore, from the listener's account or this device. */
  position: PlaybackPosition | null;
  /** The signed-in user the audiobook is loaded for; `null` for anonymous and trial listeners. */
  subject: string | null;
};

export type PlaybackSessionServices = PositionSaveServices;

export const SAVE_INTERVAL_MILLISECONDS = 5_000;

export function isPlayableAudiobook(audiobook: PreparedAudiobook): audiobook is PlayableAudiobook {
  return audiobook.status === "ready" && audiobook.narrationTrack !== undefined;
}

/**
 * Why a listening session on the audiobook cannot be created, or `null` when it can: its narration
 * track must list one start offset per synchronization unit. The player host checks this before it
 * replaces the loaded audiobook.
 */
export function findSessionRefusal(
  conversionId: string,
  { narrationTrack, narrationDocument }: PlayableAudiobook,
): Error | null {
  const unitCount = narrationDocument.synchronizationUnits.length;
  if (narrationTrack.startMilliseconds.length === unitCount) {
    return null;
  }
  return new Error(
    `Audiobook ${conversionId} has ${narrationTrack.startMilliseconds.length} start offsets for ${unitCount} synchronization units.`,
  );
}

/**
 * Where a listening position lies on the audiobook's narration track. No position, or an unknown
 * unit such as one removed from the narration document, is the start.
 */
export function toTrackPositionMilliseconds(
  audiobook: PlayableAudiobook,
  position: PlaybackPosition | null,
): number {
  if (!position) {
    return 0;
  }

  const unitIndex = audiobook.narrationDocument.synchronizationUnits.findIndex(
    (unit) => unit.id === position.synchronizationUnitId,
  );
  if (unitIndex < 0) {
    return 0;
  }

  return audiobook.narrationTrack.startMilliseconds[unitIndex]! + position.offsetMilliseconds;
}

/**
 * One subject's listening session on one loaded audiobook.
 *
 * It converts between listening positions, a synchronization unit and an offset in its audio, and
 * positions on the narration track, and it owns the save cadence and order, which the XState
 * machine in `position-saves-machine.ts` models (ADR 0009).
 */
export class PlaybackSession {
  readonly conversionId: string;
  readonly audiobook: PlayableAudiobook;
  readonly subject: string | null;
  readonly timeline: AudiobookTimeline;
  /** Where playback starts on the narration track: the restored listening position, or its start. */
  readonly initialPositionMilliseconds: number;

  private readonly services: PlaybackSessionServices;
  private readonly saves: Actor<typeof positionSavesMachine>;
  private saveFailure: string | null = null;
  private readonly saveFailureListeners = new Set<() => void>();

  constructor(request: PlaybackSessionRequest, services: PlaybackSessionServices) {
    const refusal = findSessionRefusal(request.conversionId, request.audiobook);
    if (refusal) {
      throw refusal;
    }

    const { narrationTrack } = request.audiobook;

    this.conversionId = request.conversionId;
    this.audiobook = request.audiobook;
    this.subject = request.subject;
    this.services = services;
    this.timeline = narrationTrack;
    this.initialPositionMilliseconds = toTrackPositionMilliseconds(
      request.audiobook,
      request.position,
    );
    this.saves = createActor(positionSavesMachine, {
      input: { services, subject: request.subject },
    });
    this.saves.subscribe({
      next: (snapshot) => this.publishSaveFailure(snapshot),
      error: (error: unknown) => {
        console.error("The listening session stopped saving positions.", error);
      },
    });
    this.saves.start();
  }

  /** The listening position at a position on the narration track. */
  listeningPositionAt = (positionMilliseconds: number): PlaybackPosition => {
    const unitIndex = findUnitIndexAt(this.timeline, positionMilliseconds);
    const unit = this.audiobook.narrationDocument.synchronizationUnits[unitIndex]!;

    return {
      synchronizationUnitId: unit.id,
      offsetMilliseconds: Math.max(
        0,
        positionMilliseconds - this.timeline.startMilliseconds[unitIndex]!,
      ),
    };
  };

  /**
   * Saves a position on the narration track now. Saves are written in order, and the returned
   * promise resolves once this one was written or failed; `getSaveFailure` reports failures. A save
   * that fails for a reason that can pass, such as a lost connection, is saved again later, unless
   * a newer save comes first.
   */
  save = (positionMilliseconds: number): Promise<void> =>
    new Promise((settle) => {
      this.saves.send({
        type: "SAVE",
        position: this.listeningPositionAt(positionMilliseconds),
        resolveSave: settle,
      });
    });

  /**
   * The failure to show the listener, in plain words, or `null`. A failure that a retry may fix
   * shows only once a retry, after the retry delay or a reconnect, failed too, or saves have failed
   * for as long as the retry delay; any successful save clears it.
   */
  getSaveFailure = () => this.saveFailure;

  subscribeSaveFailure = (listener: () => void) => {
    this.saveFailureListeners.add(listener);
    return () => {
      this.saveFailureListeners.delete(listener);
    };
  };

  /** Stops retrying a failed save, which the session then no longer reports. */
  close = () => {
    this.saves.send({ type: "CLOSE" });
    this.saveFailureListeners.clear();
  };

  /** Saves during playback, at most every `SAVE_INTERVAL_MILLISECONDS`. */
  saveIfDue = (positionMilliseconds: number): Promise<void> => {
    const { lastSavedAt } = this.saves.getSnapshot().context;
    if (this.services.now() - lastSavedAt < SAVE_INTERVAL_MILLISECONDS) {
      return Promise.resolve();
    }

    return this.save(positionMilliseconds);
  };

  private publishSaveFailure({ context: { saveFailure } }: PositionSavesMachineSnapshot) {
    if (saveFailure === this.saveFailure) {
      return;
    }

    this.saveFailure = saveFailure;
    for (const listener of this.saveFailureListeners) {
      listener();
    }
  }
}
