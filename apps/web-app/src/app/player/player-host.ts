import { createActor, waitFor, type Actor } from "xstate";

import type { Audiobook, PlaybackPosition } from "@cup/listener-api.routes";

import type {
  PlayableAudiobook,
  PlaybackSession,
  PlaybackSessionRequest,
  PreparedAudiobook,
} from "#src/app/player/playback-session.ts";
import {
  playerHostMachine,
  type PlayerHostMachineSnapshot,
  type UnavailableTrack,
} from "#src/app/player/player-host-machine.ts";
import {
  SKIP_MILLISECONDS,
  type CreatePlayer,
  type FindRunningPlayer,
  type Player,
} from "#src/app/player/player.ts";
import type { MediaSessionActionHandlers, MediaSessionPort } from "#src/platform/media-session.ts";
import { reportFailure } from "#src/report-failure.ts";

export type LoadedAudiobook = {
  conversionId: string;
  audiobook: PlayableAudiobook;
  subject: string | null;
  player: Player;
};

export type ShownConversion = {
  conversionId: string;
  audiobook: PreparedAudiobook | null;
  canPlay: boolean;
  resumePositionMilliseconds: number;
};

export type PlayerHostSnapshot = {
  loaded: LoadedAudiobook | null;
  shown: ShownConversion | null;
  unavailable: UnavailableTrack | null;
};

export type PlayerHostAccount =
  | { status: "restoring" }
  | { status: "known"; subject: string | null };

export type PlayerHostServices = {
  createPlayer: CreatePlayer;
  findRunningPlayer: FindRunningPlayer;
  createSession(request: PlaybackSessionRequest): PlaybackSession;
  mediaSession: MediaSessionPort;
  getAccount(): PlayerHostAccount;
  getLocalPosition(conversionId: string): PlaybackPosition | null;
  fetchAudiobook(conversionId: string): Promise<Audiobook | null>;
  now(): number;
};

export class PlayerHost {
  private readonly actor: Actor<typeof playerHostMachine>;
  private readonly services: PlayerHostServices;
  private readonly listeners = new Set<() => void>();
  private snapshot: PlayerHostSnapshot = { loaded: null, shown: null, unavailable: null };

  constructor(services: PlayerHostServices) {
    this.services = services;
    this.actor = createActor(playerHostMachine, {
      input: { services, mediaSessionHandlers: this.mediaSessionHandlers },
    });
    this.actor.subscribe({
      next: (machineSnapshot) => this.publish(machineSnapshot),
      error: (error: unknown) => {
        console.error("The player host stopped.", error);
        reportFailure("The player host stopped.")(error);
      },
    });
    this.actor.start();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  accountChanged = () => {
    this.actor.send({ type: "ACCOUNT_CHANGED" });
  };

  adoptRunningPlayer = async () => {
    if (!this.actor.getSnapshot().matches({ adoption: "notStarted" })) {
      return;
    }

    this.actor.send({ type: "FIND_RUNNING_PLAYER" });
    const { context } = await waitFor(this.actor, (snapshot) =>
      snapshot.matches({ adoption: "done" }),
    );
    if (context.adoptionFailure) {
      throw context.adoptionFailure.error;
    }
  };

  showConversion = (
    conversionId: string,
    audiobook?: PreparedAudiobook,
    receivedAt: number = this.services.now(),
  ) => {
    this.actor.send({ type: "SHOW", conversionId, audiobook, receivedAt });
  };

  hideConversion = (conversionId: string) => {
    this.actor.send({ type: "HIDE", conversionId });
  };

  play = () => {
    this.actor.send({ type: "PLAY" });
  };

  pause = () => {
    this.actor.send({ type: "PAUSE" });
  };

  togglePlayback = () => {
    if (this.snapshot.loaded?.player.getSnapshot().isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  };

  playShown = (unitIndex?: number) => {
    this.actor.send({ type: "PLAY_SHOWN", unitIndex });
    this.throwLoadFailure();
  };

  seekShown = (positionMilliseconds: number) => {
    this.actor.send({ type: "SEEK_SHOWN", positionMilliseconds });
    this.throwLoadFailure();
  };

  skipShown = (deltaMilliseconds: number) => {
    this.actor.send({ type: "SKIP_SHOWN", deltaMilliseconds });
    this.throwLoadFailure();
  };

  loadShown = () => {
    this.actor.send({ type: "LOAD_SHOWN" });
    this.throwLoadFailure();
  };

  private throwLoadFailure() {
    const { loadFailure } = this.actor.getSnapshot().context;
    if (loadFailure) {
      this.actor.send({ type: "FORGET_LOAD_FAILURE" });
      throw loadFailure.error;
    }
  }

  unload = () => {
    this.actor.send({ type: "UNLOAD", position: "save" });
  };

  release = (conversionId: string) => {
    this.actor.send({ type: "RELEASE", conversionId });
  };

  private readonly mediaSessionHandlers: MediaSessionActionHandlers = {
    play: () => this.play(),
    pause: () => this.pause(),
    stop: () => this.pause(),
    seekTo: (positionMilliseconds) => this.snapshot.loaded?.player.seekTo(positionMilliseconds),
    seekBackward: (offsetMilliseconds) =>
      this.snapshot.loaded?.player.skipBy(-(offsetMilliseconds ?? SKIP_MILLISECONDS)),
    seekForward: (offsetMilliseconds) =>
      this.snapshot.loaded?.player.skipBy(offsetMilliseconds ?? SKIP_MILLISECONDS),
  };

  private publish({ context: { loaded, shown, unavailable } }: PlayerHostMachineSnapshot) {
    const previous = this.snapshot;
    if (
      previous.loaded === loaded &&
      previous.shown === shown &&
      previous.unavailable === unavailable
    ) {
      return;
    }

    this.snapshot = { loaded, shown, unavailable };
    for (const listener of this.listeners) {
      listener();
    }
  }
}
