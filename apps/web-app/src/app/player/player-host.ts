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

/** The one audiobook the app's player holds, with the player playing it. */
export type LoadedAudiobook = {
  conversionId: string;
  audiobook: PlayableAudiobook;
  /** The signed-in user the audiobook was loaded for; `null` for anonymous and trial listeners. */
  subject: string | null;
  player: Player;
};

/** The conversion whose page the listener is on, which its Play and segment taps start. */
export type ShownConversion = {
  conversionId: string;
  /** The latest prepared version the page shows; `null` while the page has no prepared audiobook. */
  audiobook: PreparedAudiobook | null;
  /** Whether Play and segment taps on the page can start playback: it has a narration track. */
  canPlay: boolean;
  /**
   * Where loading the audiobook resumes on its narration track: the listener's listening position,
   * within the track, or the start while the page cannot play or the account is being restored.
   * Shown before the audiobook is loaded.
   */
  resumePositionMilliseconds: number;
};

export type PlayerHostSnapshot = {
  loaded: LoadedAudiobook | null;
  shown: ShownConversion | null;
  /** The last loaded track found gone, until another audiobook is loaded. */
  unavailable: UnavailableTrack | null;
};

/** The listener's account as far as playback is concerned. */
export type PlayerHostAccount =
  /** The stored session is being restored; who is listening is not known yet. */
  | { status: "restoring" }
  /** `subject` is the signed-in user, or `null` for anonymous and trial listeners. */
  | { status: "known"; subject: string | null };

export type PlayerHostServices = {
  /**
   * Builds the player for each load: on the browser's one `<audio>` element, or on the Android
   * app's native player.
   */
  createPlayer: CreatePlayer;
  /** What already plays when the page starts, which the host takes over. */
  findRunningPlayer: FindRunningPlayer;
  createSession(request: PlaybackSessionRequest): PlaybackSession;
  /** The system's media controls, which show the loaded audiobook and send their actions. */
  mediaSession: MediaSessionPort;
  /** Read at load time, so a load never uses an account state the host was not told about yet. */
  getAccount(): PlayerHostAccount;
  /** The listening position stored on this device, used for listeners without an account. */
  getLocalPosition(conversionId: string): PlaybackPosition | null;
  /**
   * Requests the audiobook again, for a newly signed narration track URL; resolves to `null` when
   * the conversion no longer exists.
   */
  fetchAudiobook(conversionId: string): Promise<Audiobook | null>;
  /** The client clock, in milliseconds. */
  now(): number;
};

/**
 * Holds the audiobook loaded into the app's player, so playback continues while the listener
 * navigates, and decides what it plays.
 *
 * A page reports the conversion it shows; showing it loads nothing. Its narration track is loaded
 * only when the listener starts it: `playShown`, or `seekShown` and `skipShown` from the player
 * sheet. Only `play` and `playShown` start playback, which must run within a user gesture. Loading
 * the shown audiobook while another one is loaded saves the previous one and replaces its player. A
 * change of the signed-in user unloads it. The loaded audiobook is shown in the system's media
 * controls, whose actions act like the app's own controls.
 *
 * The lifecycle is the XState machine in `player-host-machine.ts` (ADR 0009); this class is its
 * facade. Events are processed synchronously, so a Play sent from a user gesture reaches the player
 * within that gesture.
 */
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
      // An effect threw inside the machine; the host cannot recover from that within this page.
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

  /** Re-reads the account, after its restore finished or the signed-in user changed. */
  accountChanged = () => {
    this.actor.send({ type: "ACCOUNT_CHANGED" });
  };

  /**
   * Takes over what already plays when the page starts, such as the Android app's native session
   * after a reload, a renderer crash, a live update or a relaunch: it fetches that audiobook and
   * makes it the loaded one without loading it again, so playback goes on and the mini player shows
   * it. A deleted audiobook, or one loaded for another account, ends the session instead. Runs
   * once; a load before it finishes replaces the session's audiobook, and it then takes nothing
   * over.
   */
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

  /**
   * Reports the conversion whose page the listener is on and, once the page has it, its latest
   * prepared audiobook. Called again whenever that audiobook changes.
   *
   * `receivedAt` is when the client received the audiobook, by the client clock, which dates its
   * track URL. A page passes the time its cached response arrived, which can lie long before the
   * page showed it; without one, the audiobook counts as received now.
   */
  showConversion = (
    conversionId: string,
    audiobook?: PreparedAudiobook,
    receivedAt: number = this.services.now(),
  ) => {
    this.actor.send({ type: "SHOW", conversionId, audiobook, receivedAt });
  };

  /** The listener left the conversion's page. */
  hideConversion = (conversionId: string) => {
    this.actor.send({ type: "HIDE", conversionId });
  };

  /**
   * Plays the loaded audiobook. Must be called from a user gesture: browsers only then allow audio
   * to start.
   *
   * When the track URL is older than the renewal age, or the previous playback ended in a media
   * error, Play first requests the audiobook again and sets its newly signed URL at the same
   * position. Only that path plays after an await, which browsers allow on an element an earlier
   * gesture started; if one refuses, the next Play starts the renewed track within its gesture.
   */
  play = () => {
    this.actor.send({ type: "PLAY" });
  };

  /** Pauses, and cancels a track URL renewal that Play is waiting for. */
  pause = () => {
    this.actor.send({ type: "PAUSE" });
  };

  /** Pauses the loaded audiobook while it plays, and plays it otherwise, from a user gesture. */
  togglePlayback = () => {
    if (this.snapshot.loaded?.player.getSnapshot().isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  };

  /**
   * Plays the shown audiobook, optionally from the start of a unit, loading it first when another
   * one is loaded. Must be called from a user gesture, like `play`.
   */
  playShown = (unitIndex?: number) => {
    this.actor.send({ type: "PLAY_SHOWN", unitIndex });
    this.throwLoadFailure();
  };

  /** Seeks the shown audiobook, loading it paused first when another one is loaded. */
  seekShown = (positionMilliseconds: number) => {
    this.actor.send({ type: "SEEK_SHOWN", positionMilliseconds });
    this.throwLoadFailure();
  };

  /**
   * Skips by an amount in the shown audiobook, back when negative, loading it paused first, so the
   * skip starts from its resume position.
   */
  skipShown = (deltaMilliseconds: number) => {
    this.actor.send({ type: "SKIP_SHOWN", deltaMilliseconds });
    this.throwLoadFailure();
  };

  /** Loads the shown audiobook, paused, unless it is loaded already or cannot play. */
  loadShown = () => {
    this.actor.send({ type: "LOAD_SHOWN" });
    this.throwLoadFailure();
  };

  /** Rethrows a refused or failed load to the tap that asked for it. */
  private throwLoadFailure() {
    const { loadFailure } = this.actor.getSnapshot().context;
    if (loadFailure) {
      this.actor.send({ type: "FORGET_LOAD_FAILURE" });
      throw loadFailure.error;
    }
  }

  /** Saves the position and unloads the audiobook, which ends its playback. */
  unload = () => {
    this.actor.send({ type: "UNLOAD", position: "save" });
  };

  /**
   * Unloads the conversion, which the listener is deleting; only Play on its page loads it again,
   * also when the deletion fails. Its position is not saved, since that save would race the
   * deletion.
   */
  release = (conversionId: string) => {
    this.actor.send({ type: "RELEASE", conversionId });
  };

  /** The system's media controls act like Cup's own controls, including saving the position. */
  private readonly mediaSessionHandlers: MediaSessionActionHandlers = {
    play: () => this.play(),
    pause: () => this.pause(),
    // The audiobook stays loaded, so the listener can resume it.
    stop: () => this.pause(),
    seekTo: (positionMilliseconds) => this.snapshot.loaded?.player.seekTo(positionMilliseconds),
    seekBackward: (offsetMilliseconds) =>
      this.snapshot.loaded?.player.skipBy(-(offsetMilliseconds ?? SKIP_MILLISECONDS)),
    seekForward: (offsetMilliseconds) =>
      this.snapshot.loaded?.player.skipBy(offsetMilliseconds ?? SKIP_MILLISECONDS),
  };

  /**
   * Publishes what pages show: a new snapshot only when the loaded, shown or unavailable audiobook
   * changed, so `useSyncExternalStore` re-renders for nothing else.
   */
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
