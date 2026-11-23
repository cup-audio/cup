import type { PluginListenerHandle } from "@capacitor/core";

import type { NarrationTrack, PlaybackPosition } from "@cup/listener-api.routes";

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
import { SAVE_RETRY_FAILURE_MESSAGE } from "#src/app/player/position-saves-machine.ts";

export type NativeClosedReason =
  | "taskRemoved"
  | "notificationDismissed"
  | "closed"
  | "trackUrlExpired"
  | "serviceStopped";

export type NativePositionSave =
  | { status: "ok" }
  | { status: "failing" }
  | { status: "stillFailing" }
  | { status: "refused"; refusal: string };

export type NativePlaybackState = {
  conversionId: string;
  subject: string;
  isPlaying: boolean;
  isBuffering: boolean;
  hasEnded: boolean;
  durationMilliseconds: number;
  positionMilliseconds: number;
  positionReadAt: number;
  error: "playback" | "trackUrlExpired" | null;
  closedReason: NativeClosedReason | null;
  positionSave: NativePositionSave;
};

export type NativeLoadOptions = {
  conversionId: string;
  subject: string;
  trackUrl: string;
  positionUrl: string;
  urlsIssuedAt: number;
  timeline: Array<{ synchronizationUnitId: string; startMilliseconds: number }>;
  title: string;
  artworkUrl: string | undefined;
  durationMilliseconds: number;
  startPositionMilliseconds: number;
};

export type MediaPlaybackPlugin = {
  load(options: NativeLoadOptions): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(options: { positionMilliseconds: number }): Promise<void>;
  skipBy(options: { deltaMilliseconds: number }): Promise<void>;
  replaceUrls(options: {
    trackUrl: string;
    positionUrl: string;
    urlsIssuedAt: number;
  }): Promise<void>;
  close(options: { position: PositionOnClose }): Promise<void>;
  getState(): Promise<{ state: NativePlaybackState | null }>;
  addListener(
    eventName: "state",
    listener: (state: NativePlaybackState) => void,
  ): Promise<Pick<PluginListenerHandle, "remove">>;
};

export type NativePlayerServices = {
  now(): number;
  setInterval(callback: () => void, intervalMilliseconds: number): () => void;
  onVisible(callback: () => void): () => void;
  cachePosition(conversionId: string, position: PlaybackPosition): void;
};

const POSITION_UPDATE_INTERVAL_MILLISECONDS = 250;

export function createNativePlayers(
  plugin: MediaPlaybackPlugin,
  services: NativePlayerServices,
): CreatePlayer {
  return (session, urlsReceivedAt) => {
    const { subject } = session;
    if (subject === null) {
      throw new Error(
        `Audiobook ${session.conversionId} cannot play natively without a signed-in listener.`,
      );
    }
    return new NativeTrackPlayer(session, plugin, services, {
      kind: "load",
      subject,
      urls: readNativeUrls(session.conversionId, session.audiobook.narrationTrack, urlsReceivedAt),
    });
  };
}

type NativeUrls = { trackUrl: string; positionUrl: string; urlsReceivedAt: number };

function readNativeUrls(
  conversionId: string,
  narrationTrack: NarrationTrack,
  urlsReceivedAt: number,
): NativeUrls {
  if (narrationTrack.positionUrl === undefined) {
    throw new Error(`Audiobook ${conversionId} has no position URL to save natively with.`);
  }
  return { trackUrl: narrationTrack.url, positionUrl: narrationTrack.positionUrl, urlsReceivedAt };
}

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
    if (!state || state.closedReason !== null) {
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

type NativePlayerStart =
  | { kind: "load"; subject: string; urls: NativeUrls }
  | { kind: "adopt"; state: NativePlaybackState };

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
  private urls: NativeUrls | null;
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
      this.urls = null;
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
        closedReason: null,
        positionSave: { status: "ok" },
      };
      this.urls = start.urls;
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
    if (this.isNativelyStopped()) {
      this.sendLoad(this.readPosition());
    }
    this.setState({
      isPlaying: true,
      isBuffering: true,
      hasEnded: false,
      error: null,
      closedReason: null,
    });
    this.send(this.plugin.play());
  };

  pause = () => {
    this.setState(this.stateAt({ isPlaying: false, isBuffering: false }));
    if (!this.isNativelyStopped()) {
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
    if (!this.isNativelyStopped()) {
      this.send(this.plugin.seekTo({ positionMilliseconds: position }));
    }
  };

  skipBy = (deltaMilliseconds: number) => {
    const position = clampToTimeline(
      this.session.timeline,
      this.readPosition() + deltaMilliseconds,
    );
    this.setState(this.stateAt({ positionMilliseconds: position }));
    if (!this.isNativelyStopped()) {
      this.send(this.plugin.skipBy({ deltaMilliseconds }));
    }
  };

  replaceUrls = (narrationTrack: NarrationTrack, urlsReceivedAt: number) => {
    const urls = readNativeUrls(this.session.conversionId, narrationTrack, urlsReceivedAt);
    this.urls = urls;
    if (!this.isNativelyStopped()) {
      this.send(
        this.plugin.replaceUrls({
          trackUrl: urls.trackUrl,
          positionUrl: urls.positionUrl,
          urlsIssuedAt: urls.urlsReceivedAt,
        }),
      );
    }
  };

  showError = (message: string) => {
    this.failure = message;
    this.publish();
  };

  close = (position: PositionOnClose, ending: PlayerEnding) => {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.stopPositionUpdates?.();
    this.stopPositionUpdates = null;
    this.stopListeningForVisibility();
    this.stateListener
      .then((handle) => handle.remove())
      .catch((error: unknown) => {
        console.error("The media playback plugin did not remove its state listener.", error);
      });
    this.session.close();
    if (ending === "unload") {
      this.send(this.plugin.close({ position }));
    }
    this.listeners.clear();
    this.playbackChangeListeners.clear();
  };

  private sendLoad(startPositionMilliseconds: number) {
    if (!this.urls) {
      throw new Error(
        `Audiobook ${this.session.conversionId} has no track URL to load; Play renews it first.`,
      );
    }

    const { audiobook, conversionId, timeline } = this.session;
    this.send(
      this.plugin.load({
        conversionId,
        subject: this.state.subject,
        trackUrl: this.urls.trackUrl,
        positionUrl: this.urls.positionUrl,
        urlsIssuedAt: this.urls.urlsReceivedAt,
        timeline: audiobook.narrationDocument.synchronizationUnits.map((unit, index) => ({
          synchronizationUnitId: unit.id,
          startMilliseconds: timeline.startMilliseconds[index]!,
        })),
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
    this.services.cachePosition(
      this.session.conversionId,
      this.session.listeningPositionAt(state.positionMilliseconds),
    );
    for (const listener of this.playbackChangeListeners) {
      listener({ hasEnded: state.hasEnded });
    }
  };

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

  private isNativelyStopped() {
    return this.state.closedReason !== null;
  }

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
      needsNewTrackUrl: this.state.error === "trackUrlExpired" || this.urls === null,
      error:
        this.failure ??
        (this.state.error === "playback" ? MEDIA_ERROR_MESSAGE : null) ??
        this.readSaveFailure(),
    };
  }

  private readSaveFailure(): string | null {
    const { positionSave } = this.state;
    if (positionSave.status === "refused") {
      return positionSave.refusal;
    }
    return positionSave.status === "stillFailing" ? SAVE_RETRY_FAILURE_MESSAGE : null;
  }

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
