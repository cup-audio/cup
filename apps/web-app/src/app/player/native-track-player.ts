import type { PluginListenerHandle } from "@capacitor/core";

import { clampToTimeline, findUnitIndexAt } from "#src/app/player/audiobook-timeline.ts";
import type { PlaybackSession } from "#src/app/player/playback-session.ts";
import {
  isSameSnapshot,
  MEDIA_ERROR_MESSAGE,
  type CreatePlayer,
  type FindRunningPlayer,
  type PlaybackChange,
  type Player,
  type PlayerEnding,
  type PlayerSnapshot,
  type PositionOnClose,
} from "#src/app/player/player.ts";

/** Why the plugin ended its session without the page. */
export type NativeClosedReason =
  /** The listener swiped Cup from recents while it was paused. */
  | "taskRemoved"
  /** The listener swiped the notification away, after the service left the foreground. */
  | "notificationDismissed"
  /** The URLs expired while paused, or the server refused the track URL. */
  | "trackUrlExpired"
  /** Android stopped the service for another reason. */
  | "serviceStopped";

/** What the Android app's plugin reports after every change of its ExoPlayer. */
export type NativePlaybackState = {
  conversionId: string;
  /** The signed-in user the audiobook was loaded for. */
  subject: string;
  /** Whether ExoPlayer plays or waits for data to play; `false` while focus loss suppresses it. */
  isPlaying: boolean;
  isBuffering: boolean;
  /** The audiobook just reached its end; ExoPlayer is paused back at its start. */
  hasEnded: boolean;
  /** `0` until ExoPlayer read the track's duration. */
  durationMilliseconds: number;
  positionMilliseconds: number;
  /** When ExoPlayer was at `positionMilliseconds`, in epoch milliseconds, the page's clock. */
  positionReadAt: number;
  /**
   * `"playback"`: loading the track failed, and ExoPlayer paused. `"trackUrlExpired"`: only newly
   * signed URLs play, and the session closed.
   */
  error: "playback" | "trackUrlExpired" | null;
  /**
   * The plugin ended the session without the page and dropped its media item; the position is the
   * last one. It keeps reporting this state until the next `load`.
   */
  closed: boolean;
  closedReason: NativeClosedReason | null;
};

export type NativeLoadOptions = {
  conversionId: string;
  subject: string;
  trackUrl: string;
  /** When the page received the audiobook response that carried the URLs, by the page's clock. */
  urlsIssuedAt: number;
  title: string;
  artworkUrl: string | undefined;
  /** The narration track's listed duration, which the system's media controls show. */
  durationMilliseconds: number;
  startPositionMilliseconds: number;
};

/**
 * The Android app's media playback plugin (`MediaPlaybackPlugin.java`): a Media3 ExoPlayer in a
 * `mediaPlayback` media session service, which plays the narration track and serves the system's
 * media controls without the page. Its session outlives the page.
 */
export type MediaPlaybackPlugin = {
  /** Sets the media item without preparing it: nothing is fetched or shown until Play. */
  load(options: NativeLoadOptions): Promise<void>;
  /** Prepares and plays; the first Play starts the service in the foreground. */
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(options: { positionMilliseconds: number }): Promise<void>;
  /** Skips from ExoPlayer's own position. */
  skipBy(options: { deltaMilliseconds: number }): Promise<void>;
  /** Replaces the URLs, which the page received at `urlsIssuedAt`, keeping the position. */
  replaceUrls(options: { trackUrl: string; urlsIssuedAt: number }): Promise<void>;
  /** Releases ExoPlayer and stops the service. */
  close(options: { position: PositionOnClose }): Promise<void>;
  /** The current state, the last native stop's, or `null` without a session. */
  getState(): Promise<{ state: NativePlaybackState | null }>;
  addListener(
    eventName: "state",
    listener: (state: NativePlaybackState) => void,
  ): Promise<Pick<PluginListenerHandle, "remove">>;
};

export type NativePlayerServices = {
  /** The client clock, in epoch milliseconds, which the plugin's `positionReadAt` shares. */
  now(): number;
  /** Calls `callback` repeatedly until the returned function stops it. */
  setInterval(callback: () => void, intervalMilliseconds: number): () => void;
  /** Calls `callback` whenever the page becomes visible again, until the returned function. */
  onVisible(callback: () => void): () => void;
};

/** How often the shown position moves on while ExoPlayer plays, like a media element's updates. */
const POSITION_UPDATE_INTERVAL_MILLISECONDS = 250;

/**
 * Plays every loaded audiobook on the Android app's native player. Only signed-in listeners play in
 * the app (ADR 0017), and the plugin's session belongs to the account it was loaded for.
 */
export function createNativePlayers(
  plugin: MediaPlaybackPlugin,
  services: NativePlayerServices,
): CreatePlayer {
  return (session, trackUrlReceivedAt) => {
    const { subject } = session;
    if (subject === null) {
      throw new Error(
        `Audiobook ${session.conversionId} cannot play natively without a signed-in listener.`,
      );
    }
    return new NativeTrackPlayer(session, plugin, services, {
      kind: "load",
      subject,
      trackUrlReceivedAt,
    });
  };
}

/**
 * Finds the plugin's session when the page starts, which outlives a reload, a renderer crash, a
 * live update and a relaunch while it plays. A session the plugin closed is not running.
 */
export function createRunningPlayerFinder(
  plugin: MediaPlaybackPlugin,
  services: NativePlayerServices,
): FindRunningPlayer {
  return async () => {
    let state: NativePlaybackState | null;
    try {
      ({ state } = await plugin.getState());
    } catch (error) {
      console.error("The media playback plugin did not report its state.", error);
      return null;
    }
    if (!state || state.closed) {
      return null;
    }

    return {
      conversionId: state.conversionId,
      subject: state.subject,
      adopt: (session) =>
        new NativeTrackPlayer(session, plugin, services, { kind: "adopt", state }),
      discard: () => {
        plugin.close({ position: "discard" }).catch((error: unknown) => {
          console.error("The media playback plugin did not close its session.", error);
        });
      },
    };
  };
}

/** How the player starts: loading the audiobook, or taking over the session that plays it. */
type NativePlayerStart =
  | { kind: "load"; subject: string; trackUrlReceivedAt: number }
  | { kind: "adopt"; state: NativePlaybackState };

/**
 * Plays a loaded audiobook on the Android app's ExoPlayer, through its plugin.
 *
 * The plugin is the only playback state: the snapshot follows its `state` events, and while it
 * plays, the position moves on from the time it was read. A command shows its effect at once, until
 * the plugin reports. The plugin owns the listening position, so this player saves nothing.
 *
 * After a native stop the plugin has no media item. The audiobook stays loaded at the last
 * position, seeks move only that position, and the next Play loads the audiobook again and plays.
 */
class NativeTrackPlayer implements Player {
  private readonly session: PlaybackSession;
  private readonly plugin: MediaPlaybackPlugin;
  private readonly services: NativePlayerServices;
  private readonly listeners = new Set<() => void>();
  private readonly playbackChangeListeners = new Set<(change: PlaybackChange) => void>();
  private readonly stateListener: Promise<Pick<PluginListenerHandle, "remove">>;
  private readonly stopListeningForVisibility: () => void;
  private stopPositionUpdates: (() => void) | null = null;
  private state: NativePlaybackState;
  /** The track URL the next load uses, and when the page received it. */
  private trackUrl: { url: string; receivedAt: number } | null;
  private failure: string | null = null;
  private isClosed = false;
  private snapshot: PlayerSnapshot;

  constructor(
    session: PlaybackSession,
    plugin: MediaPlaybackPlugin,
    services: NativePlayerServices,
    start: NativePlayerStart,
  ) {
    this.session = session;
    this.plugin = plugin;
    this.services = services;

    this.stateListener = plugin.addListener("state", this.handleState);
    if (start.kind === "adopt") {
      this.state = start.state;
      // The session's URLs came from an earlier page, which the next Play renews.
      this.trackUrl = null;
    } else {
      this.state = {
        conversionId: session.conversionId,
        subject: start.subject,
        isPlaying: false,
        isBuffering: false,
        hasEnded: false,
        durationMilliseconds: 0,
        positionMilliseconds: session.initialPositionMilliseconds,
        positionReadAt: services.now(),
        error: null,
        closed: false,
        closedReason: null,
      };
      this.trackUrl = {
        url: session.audiobook.narrationTrack.url,
        receivedAt: start.trackUrlReceivedAt,
      };
      this.sendLoad(session.initialPositionMilliseconds);
    }
    this.stopListeningForVisibility = services.onVisible(this.refreshState);
    this.snapshot = this.readSnapshot();
    if (start.kind === "adopt") {
      this.setState({});
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  subscribePlaybackChanges = (listener: (change: PlaybackChange) => void) => {
    this.playbackChangeListeners.add(listener);
    return () => {
      this.playbackChangeListeners.delete(listener);
    };
  };

  play = () => {
    this.failure = null;
    if (this.state.closed) {
      this.sendLoad(this.readPosition());
    }
    this.setState({
      isPlaying: true,
      isBuffering: true,
      hasEnded: false,
      error: null,
      closed: false,
      closedReason: null,
    });
    this.send(this.plugin.play());
  };

  pause = () => {
    this.setState(this.stateAt({ isPlaying: false, isBuffering: false }));
    if (!this.state.closed) {
      this.send(this.plugin.pause());
    }
  };

  seekToUnit = (unitIndex: number) => {
    const startMilliseconds = this.session.timeline.startMilliseconds[unitIndex];
    if (startMilliseconds === undefined) {
      throw new Error(`Audiobook ${this.session.conversionId} has no unit ${unitIndex}.`);
    }

    this.seekTo(startMilliseconds);
  };

  seekTo = (positionMilliseconds: number) => {
    const position = clampToTimeline(this.session.timeline, positionMilliseconds);
    this.setState(this.stateAt({ positionMilliseconds: position }));
    if (!this.state.closed) {
      this.send(this.plugin.seekTo({ positionMilliseconds: position }));
    }
  };

  skipBy = (deltaMilliseconds: number) => {
    const position = clampToTimeline(
      this.session.timeline,
      this.readPosition() + deltaMilliseconds,
    );
    this.setState(this.stateAt({ positionMilliseconds: position }));
    if (!this.state.closed) {
      this.send(this.plugin.skipBy({ deltaMilliseconds }));
    }
  };

  /** After a native stop the plugin has no item to replace, so the next load uses the URL. */
  replaceTrackUrl = (url: string, receivedAt: number) => {
    this.trackUrl = { url, receivedAt };
    if (!this.state.closed) {
      this.send(this.plugin.replaceUrls({ trackUrl: url, urlsIssuedAt: receivedAt }));
    }
  };

  showError = (message: string) => {
    this.failure = message;
    this.publish();
  };

  /** Unloading closes the plugin's session; another audiobook's `load` replaces its item instead. */
  close = (position: PositionOnClose, ending: PlayerEnding) => {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.stopPositionUpdates?.();
    this.stopPositionUpdates = null;
    this.stopListeningForVisibility();
    void this.stateListener.then((handle) => handle.remove());
    this.session.close();
    if (ending === "unload") {
      this.send(this.plugin.close({ position }));
    }
    this.listeners.clear();
    this.playbackChangeListeners.clear();
  };

  private sendLoad(startPositionMilliseconds: number) {
    if (!this.trackUrl) {
      throw new Error(
        `Audiobook ${this.session.conversionId} has no track URL to load; Play renews it first.`,
      );
    }

    const { audiobook, conversionId, timeline } = this.session;
    this.send(
      this.plugin.load({
        conversionId,
        subject: this.state.subject,
        trackUrl: this.trackUrl.url,
        urlsIssuedAt: this.trackUrl.receivedAt,
        title: audiobook.title,
        artworkUrl: audiobook.coverImage?.url,
        durationMilliseconds: timeline.durationMilliseconds,
        startPositionMilliseconds,
      }),
    );
  }

  private handleState = (state: NativePlaybackState) => {
    if (this.isClosed || state.conversionId !== this.session.conversionId) {
      return;
    }

    this.setState(state);
    for (const listener of this.playbackChangeListeners) {
      listener({ hasEnded: state.hasEnded });
    }
  };

  /** Events sent while the WebView suspended the hidden page can be lost. */
  private refreshState = () => {
    void this.readPluginState();
  };

  private async readPluginState() {
    try {
      const { state } = await this.plugin.getState();
      if (state) {
        this.handleState(state);
      }
    } catch (error) {
      console.error("The media playback plugin did not report its state.", error);
    }
  }

  /** The current state with the position read now, changed by `changes`. */
  private stateAt(changes: Partial<NativePlaybackState>): Partial<NativePlaybackState> {
    return {
      positionMilliseconds: this.readPosition(),
      positionReadAt: this.services.now(),
      ...changes,
    };
  }

  private setState(changes: Partial<NativePlaybackState>) {
    this.state = { ...this.state, ...changes };

    const isMoving = this.state.isPlaying && !this.state.isBuffering;
    if (isMoving && !this.stopPositionUpdates) {
      this.stopPositionUpdates = this.services.setInterval(
        () => this.publish(),
        POSITION_UPDATE_INTERVAL_MILLISECONDS,
      );
    } else if (!isMoving && this.stopPositionUpdates) {
      this.stopPositionUpdates();
      this.stopPositionUpdates = null;
    }
    this.publish();
  }

  private readDuration() {
    // The track's listed duration stands in until ExoPlayer read the file's own.
    return this.state.durationMilliseconds > 0
      ? this.state.durationMilliseconds
      : this.session.timeline.durationMilliseconds;
  }

  private readPosition() {
    const { isPlaying, isBuffering, positionMilliseconds, positionReadAt } = this.state;
    const elapsedMilliseconds =
      isPlaying && !isBuffering ? Math.max(0, this.services.now() - positionReadAt) : 0;
    return Math.min(positionMilliseconds + elapsedMilliseconds, this.readDuration());
  }

  private readSnapshot(): PlayerSnapshot {
    const positionMilliseconds = this.readPosition();

    return {
      currentUnitIndex: findUnitIndexAt(this.session.timeline, positionMilliseconds),
      positionMilliseconds,
      durationMilliseconds: this.readDuration(),
      isPlaying: this.state.isPlaying,
      isBuffering: this.state.isBuffering,
      playbackRate: 1,
      // A failed load is retried at the same URL; ExoPlayer prepares the item again on Play. Only
      // expired URLs, or a session taken over with URLs of unknown age, need new ones.
      needsNewTrackUrl: this.state.error === "trackUrlExpired" || this.trackUrl === null,
      error: this.failure ?? (this.state.error === "playback" ? MEDIA_ERROR_MESSAGE : null),
    };
  }

  /** Replaces the snapshot only when a value changed, as `useSyncExternalStore` re-renders. */
  private publish() {
    if (this.isClosed) {
      return;
    }

    const next = this.readSnapshot();
    if (isSameSnapshot(next, this.snapshot)) {
      return;
    }

    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** A command the plugin rejects shows as a failure to play. */
  private send(call: Promise<unknown>) {
    call.catch((error: unknown) => {
      console.error("The media playback plugin rejected a command.", error);
      if (this.isClosed) {
        return;
      }
      this.failure = MEDIA_ERROR_MESSAGE;
      this.publish();
    });
  }
}
