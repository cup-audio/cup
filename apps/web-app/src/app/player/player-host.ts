import type { Audiobook, PlaybackPosition } from "@cup/listener-api.routes";

import { clampToTimeline } from "#src/app/player/audiobook-timeline.ts";
import {
  isPlayableAudiobook,
  toTrackPositionMilliseconds,
  type PlayableAudiobook,
  type PlaybackSession,
  type PlaybackSessionRequest,
  type PreparedAudiobook,
} from "#src/app/player/playback-session.ts";
import {
  SKIP_MILLISECONDS,
  type CreatePlayer,
  type FindRunningPlayer,
  type PlaybackChange,
  type Player,
  type PlayerEnding,
  type PositionOnClose,
} from "#src/app/player/player.ts";
import type { MediaSessionActionHandlers, MediaSessionPort } from "#src/platform/media-session.ts";

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

/** A track that was loaded and no longer exists, such as one deleted on another device. */
type UnavailableTrack = { conversionId: string; message: string };

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
 * How old a track URL may be before Play renews it. The signed URL stays valid for at least 24
 * hours after the server handed it out, by the server clock; half of that tolerates a skewed client
 * clock.
 */
const TRACK_URL_RENEWAL_AGE_MILLISECONDS = 12 * 60 * 60 * 1_000;
const RENEWAL_ERROR_MESSAGE = "The audio could not be loaded again. Press Play to try again.";
const UNAVAILABLE_TRACK_MESSAGE = "This track is no longer available.";

/**
 * Holds the audiobook loaded into the app's player, so playback continues while the listener
 * navigates, and decides what it plays.
 *
 * A page reports the conversion it shows; showing it loads nothing. Its narration track is loaded
 * only when the listener starts it: `playShown`, or `loadShown` for seeking and skipping. Only
 * `play` and `playShown` start playback, which must run within a user gesture. Loading the shown
 * audiobook while another one is loaded saves the previous one and replaces its player. A change of
 * the signed-in user unloads it. The loaded audiobook is shown in the system's media controls,
 * whose actions act like the app's own controls.
 */
export class PlayerHost {
  private readonly services: PlayerHostServices;
  private readonly listeners = new Set<() => void>();
  private snapshot: PlayerHostSnapshot = { loaded: null, shown: null, unavailable: null };
  /** When the client received the shown audiobook, whose track URL a load uses. */
  private shownAudiobookReceivedAt = 0;
  /** When the client received the loaded audiobook's signed URLs. */
  private urlsReceivedAt = 0;
  /** The renewal Play is waiting for; Pause and unloading cancel it. */
  private pendingRenewal: symbol | null = null;
  /** Stops reporting the loaded player's playback changes to the system's media controls. */
  private unsubscribeMediaSessionReports: (() => void) | null = null;
  /** The host looks for a running player once, when the page starts. */
  private hasLookedForRunningPlayer = false;
  /** Called once the account is known, by what waits for its restore. */
  private readonly accountWaiters = new Set<() => void>();

  constructor(services: PlayerHostServices) {
    this.services = services;
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
    const account = this.services.getAccount();
    const subject = account.status === "known" ? account.subject : null;

    // The listening position belongs to the user the audiobook was loaded for.
    const { loaded } = this.snapshot;
    if (account.status === "known" && loaded && loaded.subject !== subject) {
      this.unload();
    }

    // Which listening position applies depends on the account.
    this.refreshResumePosition();

    if (account.status === "known") {
      for (const waiter of this.accountWaiters) {
        waiter();
      }
      this.accountWaiters.clear();
    }
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
    if (this.hasLookedForRunningPlayer) {
      return;
    }
    this.hasLookedForRunningPlayer = true;

    const running = await this.services.findRunningPlayer();
    if (!running) {
      return;
    }
    const subject = await this.readKnownSubject();
    if (this.snapshot.loaded) {
      return;
    }
    if (running.subject !== subject) {
      running.discard();
      return;
    }

    let audiobook: Audiobook | null;
    try {
      audiobook = await this.services.fetchAudiobook(running.conversionId);
    } catch {
      // The request layer reports the failure itself; the session plays on, and the next load
      // replaces it.
      return;
    }
    if (this.snapshot.loaded) {
      return;
    }
    if (audiobook?.status !== "ready" || !isPlayableAudiobook(audiobook)) {
      running.discard();
      return;
    }

    const { conversionId } = running;
    const session = this.services.createSession({
      conversionId,
      audiobook,
      position: this.readStoredPosition(conversionId, audiobook, subject),
      subject,
    });
    // The session's URLs came from an earlier page, so the adopted player asks for new ones
    // (`needsNewTrackUrl`) and the first Play renews them.
    this.setLoaded({ conversionId, audiobook, subject, player: running.adopt(session) });
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
    const previous =
      this.snapshot.shown?.conversionId === conversionId ? this.snapshot.shown : null;
    const shownAudiobook = audiobook ?? previous?.audiobook ?? null;
    if (shownAudiobook !== previous?.audiobook) {
      this.shownAudiobookReceivedAt = receivedAt;
    }
    this.update({
      shown: {
        conversionId,
        audiobook: shownAudiobook,
        canPlay:
          shownAudiobook !== null &&
          isPlayableAudiobook(shownAudiobook) &&
          this.snapshot.unavailable?.conversionId !== conversionId,
        resumePositionMilliseconds: this.readResumePositionMilliseconds(
          conversionId,
          shownAudiobook,
        ),
      },
    });
  };

  /** The listener left the conversion's page. */
  hideConversion = (conversionId: string) => {
    if (this.snapshot.shown?.conversionId !== conversionId) {
      return;
    }

    this.update({ shown: null });
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
    const { loaded } = this.snapshot;
    if (!loaded || this.pendingRenewal) {
      return;
    }

    const trackUrlAge = this.services.now() - this.urlsReceivedAt;
    if (
      loaded.player.getSnapshot().needsNewTrackUrl ||
      trackUrlAge > TRACK_URL_RENEWAL_AGE_MILLISECONDS
    ) {
      void this.renewTrackUrlAndPlay(loaded);
      return;
    }

    loaded.player.play();
  };

  pause = () => {
    this.pendingRenewal = null;
    this.snapshot.loaded?.player.pause();
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
    const player = this.loadShown();
    if (!player) {
      return;
    }

    if (unitIndex !== undefined) {
      player.seekToUnit(unitIndex);
    }
    this.play();
  };

  /**
   * Loads the shown audiobook, paused, unless it is loaded already, and returns its player, so the
   * player sheet can seek it before it plays. Returns `null` while the shown audiobook cannot
   * play.
   */
  loadShown = (): Player | null => {
    const { shown } = this.snapshot;
    if (!shown?.canPlay) {
      return null;
    }

    if (!this.isShownLoaded()) {
      this.load(shown);
    }
    return this.snapshot.loaded?.player ?? null;
  };

  /** Saves the position and unloads the audiobook, which ends its playback. */
  unload = () => {
    this.unloadPlayer("save");
  };

  /**
   * Unloads the conversion, which the listener is deleting; only Play on its page loads it again,
   * also when the deletion fails. Its position is not saved, since that save would race the
   * deletion.
   */
  release = (conversionId: string) => {
    if (this.snapshot.loaded?.conversionId === conversionId) {
      this.unloadPlayer("discard");
    }
  };

  /** Who listens, once the stored account is restored. */
  private async readKnownSubject(): Promise<string | null> {
    const account = this.services.getAccount();
    if (account.status === "known") {
      return account.subject;
    }

    await new Promise<void>((resolve) => this.accountWaiters.add(resolve));
    return this.readKnownSubject();
  }

  /** Signed-in listeners keep their position on the server; others on the device. */
  private readStoredPosition(
    conversionId: string,
    audiobook: PlayableAudiobook,
    subject: string | null,
  ): PlaybackPosition | null {
    return subject === null
      ? this.services.getLocalPosition(conversionId)
      : audiobook.playbackPosition;
  }

  private readResumePositionMilliseconds(
    conversionId: string,
    audiobook: PreparedAudiobook | null,
  ): number {
    const account = this.services.getAccount();
    if (!audiobook || !isPlayableAudiobook(audiobook) || account.status === "restoring") {
      return 0;
    }

    return clampToTimeline(
      audiobook.narrationTrack,
      toTrackPositionMilliseconds(
        audiobook,
        this.readStoredPosition(conversionId, audiobook, account.subject),
      ),
    );
  }

  /**
   * Reads the shown audiobook's resume position again, after its listening position may have
   * changed.
   */
  private refreshResumePosition() {
    const { shown } = this.snapshot;
    if (!shown) {
      return;
    }

    const resumePositionMilliseconds = this.readResumePositionMilliseconds(
      shown.conversionId,
      shown.audiobook,
    );
    if (resumePositionMilliseconds !== shown.resumePositionMilliseconds) {
      this.update({ shown: { ...shown, resumePositionMilliseconds } });
    }
  }

  private isShownLoaded() {
    const { shown, loaded } = this.snapshot;
    return shown !== null && shown.conversionId === loaded?.conversionId;
  }

  private load({ conversionId, audiobook }: ShownConversion) {
    if (!audiobook || !isPlayableAudiobook(audiobook)) {
      throw new Error(`Audiobook ${conversionId} cannot be loaded without a narration track.`);
    }

    this.closeLoadedPlayer("save", "replace");

    const account = this.services.getAccount();
    const subject = account.status === "known" ? account.subject : null;
    const session = this.services.createSession({
      conversionId,
      audiobook,
      position: this.readStoredPosition(conversionId, audiobook, subject),
      subject,
    });
    this.urlsReceivedAt = this.shownAudiobookReceivedAt;
    const player = this.services.createPlayer(session, this.urlsReceivedAt);
    this.setLoaded({ conversionId, audiobook, subject, player });
  }

  /** Makes `loaded` the loaded audiobook and shows it in the system's media controls. */
  private setLoaded(loaded: LoadedAudiobook) {
    const { audiobook, player } = loaded;
    this.update({ loaded, unavailable: null });

    const { mediaSession } = this.services;
    mediaSession.setMetadata({ title: audiobook.title, artworkUrl: audiobook.coverImage?.url });
    mediaSession.setActionHandlers(this.mediaSessionHandlers);
    this.unsubscribeMediaSessionReports = player.subscribePlaybackChanges(
      this.reportToMediaSession,
    );
    this.reportToMediaSession();
  }

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
   * Tells the system's media controls the loaded audiobook's playback and position state. The
   * duration is the narration track's listed one, the timeline the reader and the position bar use,
   * not the player's.
   */
  private reportToMediaSession = (change?: PlaybackChange) => {
    const { loaded } = this.snapshot;
    if (!loaded) {
      return;
    }

    const { positionMilliseconds, isPlaying, isBuffering, playbackRate } =
      loaded.player.getSnapshot();
    const { durationMilliseconds } = loaded.audiobook.narrationTrack;
    const { mediaSession } = this.services;
    mediaSession.setPlaybackState({
      playbackState: isPlaying ? "playing" : "paused",
      isWaiting: isBuffering,
      // The player returns to the start at the end, so only the change tells it ended.
      hasEnded: change?.hasEnded ?? false,
    });
    mediaSession.setPositionState({
      durationMilliseconds,
      positionMilliseconds: Math.min(positionMilliseconds, durationMilliseconds),
      playbackRate,
    });
  };

  private async renewTrackUrlAndPlay(loaded: LoadedAudiobook) {
    const renewal = Symbol("renewal");
    this.pendingRenewal = renewal;

    let response: { result: "received"; audiobook: Audiobook | null } | { result: "failed" };
    try {
      response = {
        result: "received",
        audiobook: await this.services.fetchAudiobook(loaded.conversionId),
      };
    } catch {
      // The request layer reports the failure itself; the player shows that Play did not start.
      response = { result: "failed" };
    }
    // Pause, unloading or loading another audiobook during the request cancelled the renewal.
    if (this.pendingRenewal !== renewal) {
      return;
    }
    this.pendingRenewal = null;

    if (response.result === "received" && response.audiobook === null) {
      this.reportUnavailable(loaded.conversionId);
      return;
    }

    const audiobook = response.result === "received" ? response.audiobook : null;
    // Without a narration track the audiobook is no longer playable, e.g. after a retry.
    if (audiobook?.status !== "ready" || !audiobook.narrationTrack) {
      loaded.player.showError(RENEWAL_ERROR_MESSAGE);
      return;
    }

    this.urlsReceivedAt = this.services.now();
    loaded.player.replaceUrls(audiobook.narrationTrack, this.urlsReceivedAt);
    loaded.player.play();
  }

  /** Unloads a track that no longer exists and keeps its page from playing it. */
  private reportUnavailable(conversionId: string) {
    // The position of a track that no longer exists has nowhere to go.
    this.unloadPlayer("discard");
    const { shown } = this.snapshot;
    this.update({
      unavailable: { conversionId, message: UNAVAILABLE_TRACK_MESSAGE },
      shown: shown?.conversionId === conversionId ? { ...shown, canPlay: false } : shown,
    });
  }

  private unloadPlayer(position: PositionOnClose) {
    if (!this.snapshot.loaded) {
      return;
    }

    this.closeLoadedPlayer(position, "unload");
    this.update({ loaded: null });
    // Playback moved the listening position, which a listener without an account keeps only on the
    // device, where the shown audiobook does not see it change.
    this.refreshResumePosition();
  }

  private closeLoadedPlayer(position: PositionOnClose, ending: PlayerEnding) {
    this.pendingRenewal = null;
    if (!this.snapshot.loaded) {
      return;
    }

    this.unsubscribeMediaSessionReports?.();
    this.unsubscribeMediaSessionReports = null;
    this.snapshot.loaded.player.close(position, ending);
    this.services.mediaSession.clear();
  }

  private update(value: Partial<PlayerHostSnapshot>) {
    this.snapshot = { ...this.snapshot, ...value };
    for (const listener of this.listeners) {
      listener();
    }
  }
}
