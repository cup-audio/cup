import { createActor, type Actor } from "xstate";

import type { Audiobook, NarrationTrack, PlaybackPosition } from "@cup/listener-api.routes";

import { findUnitIndexAt, type AudiobookTimeline } from "#src/app/player/audiobook-timeline.ts";
import {
  positionSavesMachine,
  type PositionSavesMachineSnapshot,
} from "#src/app/player/position-saves-machine.ts";
import { reportFailure } from "#src/report-failure.ts";

export type PreparedAudiobook = Extract<
  Audiobook,
  { status: "insufficient-duration" | "synthesizing" | "ready" }
>;
export type PlayableAudiobook = Extract<Audiobook, { status: "ready" }> & {
  narrationTrack: NarrationTrack;
};

export type PlaybackSessionRequest = {
  conversionId: string;
  audiobook: PlayableAudiobook;
  position: PlaybackPosition | null;
  subject: string | null;
};

export type PlaybackSessionServices = {
  savePosition(position: PlaybackPosition, subject: string | null): Promise<void>;
  now(): number;
  setRetryTimer(callback: () => void, delayMilliseconds: number): () => void;
  onReconnect(callback: () => void): () => void;
};

export const SAVE_INTERVAL_MILLISECONDS = 5_000;

export function isPlayableAudiobook(audiobook: PreparedAudiobook): audiobook is PlayableAudiobook {
  return audiobook.status === "ready" && audiobook.narrationTrack !== undefined;
}

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

export class PlaybackSession {
  readonly conversionId: string;
  readonly audiobook: PlayableAudiobook;
  readonly subject: string | null;
  readonly timeline: AudiobookTimeline;
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
        reportFailure("The listening session stopped saving positions.")(error);
      },
    });
    this.saves.start();
  }

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

  save = (positionMilliseconds: number): Promise<void> =>
    new Promise((settle) => {
      this.saves.send({
        type: "SAVE",
        position: this.listeningPositionAt(positionMilliseconds),
        resolveSave: settle,
      });
    });

  getSaveFailure = () => this.saveFailure;

  subscribeSaveFailure = (listener: () => void) => {
    this.saveFailureListeners.add(listener);
    return () => {
      this.saveFailureListeners.delete(listener);
    };
  };

  close = () => {
    this.saves.send({ type: "CLOSE" });
    this.saveFailureListeners.clear();
  };

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
