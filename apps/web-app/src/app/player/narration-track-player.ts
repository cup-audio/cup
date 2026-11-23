import type { NarrationTrack } from "@cup/listener-api.routes";

import { clampToTimeline, findUnitIndexAt } from "#src/app/player/audiobook-timeline.ts";
import type { PlaybackSession } from "#src/app/player/playback-session.ts";
import {
  isSameSnapshot,
  MEDIA_ERROR_MESSAGE,
  type CreatePlayer,
  type PlaybackChange,
  type Player,
  type PlayerEnding,
  type PlayerSnapshot,
  type PositionOnClose,
} from "#src/app/player/player.ts";

export type NarrationAudioElement = EventTarget & {
  src: string;
  currentTime: number;
  preload: string;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  readonly playbackRate: number;
  readonly error: { code: number } | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
};

const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;
const MEDIA_EVENT_TYPES = [
  "loadedmetadata",
  "durationchange",
  "play",
  "playing",
  "waiting",
  "pause",
  "seeked",
  "timeupdate",
  "ended",
  "ratechange",
  "error",
] as const;
const PLAYBACK_CHANGE_EVENT_TYPES = new Set<string>([
  "play",
  "pause",
  "seeked",
  "ratechange",
  "waiting",
  "playing",
  "ended",
]);

export function createElementPlayers(element: NarrationAudioElement): CreatePlayer {
  element.preload = "metadata";
  return (session) => new NarrationTrackPlayer(session, element);
}

function isElementPlaying(element: Pick<NarrationAudioElement, "paused" | "error">) {
  return !element.paused && !element.error;
}

function canSeek(element: Pick<NarrationAudioElement, "readyState" | "duration">) {
  return element.readyState >= HAVE_METADATA && element.duration > 0;
}

const SEEK_TOLERANCE_MILLISECONDS = 100;

export class NarrationTrackPlayer implements Player {
  private readonly session: PlaybackSession;
  private readonly element: NarrationAudioElement;
  private readonly listeners = new Set<() => void>();
  private readonly playbackChangeListeners = new Set<(change: PlaybackChange) => void>();
  private pendingPositionMilliseconds: number | null;
  private seek: { targetMilliseconds: number; isRetry: boolean } | null = null;
  private failure: string | null = null;
  private readonly unsubscribeSaveFailure: () => void;
  private isClosed = false;
  private snapshot: PlayerSnapshot;

  constructor(session: PlaybackSession, element: NarrationAudioElement) {
    this.session = session;
    this.element = element;
    this.pendingPositionMilliseconds = session.initialPositionMilliseconds;

    for (const type of MEDIA_EVENT_TYPES) {
      element.addEventListener(type, this.handleMediaEvent);
    }
    element.src = session.audiobook.narrationTrack.url;
    this.unsubscribeSaveFailure = session.subscribeSaveFailure(() => this.publish());
    this.snapshot = this.readSnapshot();
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

    const playing = this.element.play();
    this.publish();
    playing.catch((error: unknown) => {
      if (this.isClosed || (error instanceof DOMException && error.name === "AbortError")) {
        return;
      }
      this.failure = MEDIA_ERROR_MESSAGE;
      this.publish();
    });
  };

  pause = () => {
    this.element.pause();
    this.publish();
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
    if (!canSeek(this.element)) {
      this.pendingPositionMilliseconds = position;
    } else {
      this.pendingPositionMilliseconds = null;
      this.seekElement(position);
    }

    this.save("now", position);
    this.publish();
  };

  skipBy = (deltaMilliseconds: number) => {
    this.seekTo(this.readPosition() + deltaMilliseconds);
  };

  replaceUrls = (narrationTrack: NarrationTrack) => {
    this.pendingPositionMilliseconds = this.readPosition();
    this.seek = null;
    this.element.src = narrationTrack.url;
    this.publish();
  };

  showError = (message: string) => {
    this.failure = message;
    this.publish();
  };

  close = (position: PositionOnClose, ending: PlayerEnding) => {
    if (this.isClosed) {
      return;
    }

    if (position === "save") {
      this.save("now", this.readPosition());
    }
    this.isClosed = true;
    this.unsubscribeSaveFailure();
    this.session.close();
    for (const type of MEDIA_EVENT_TYPES) {
      this.element.removeEventListener(type, this.handleMediaEvent);
    }
    this.element.pause();
    if (ending === "unload") {
      this.element.removeAttribute("src");
      this.element.load();
    }
    this.listeners.clear();
    this.playbackChangeListeners.clear();
  };

  private handleMediaEvent = (event: Event) => {
    const { element } = this;

    if (this.pendingPositionMilliseconds !== null && canSeek(element)) {
      this.applyPendingPosition();
    }

    switch (event.type) {
      case "seeked": {
        this.confirmSeek();
        break;
      }
      case "timeupdate": {
        if (!element.seeking && !element.paused) {
          this.save("if-due", this.readPosition());
        }
        break;
      }
      case "pause": {
        if (element.paused && !element.ended) {
          this.save("now", this.readPosition());
        }
        break;
      }
      case "ended": {
        this.seek = null;
        element.currentTime = 0;
        this.save("now", 0);
        break;
      }
    }

    this.publish();
    if (PLAYBACK_CHANGE_EVENT_TYPES.has(event.type)) {
      for (const listener of this.playbackChangeListeners) {
        listener({ hasEnded: event.type === "ended" });
      }
    }
  };

  private applyPendingPosition() {
    const position = this.pendingPositionMilliseconds;
    this.pendingPositionMilliseconds = null;
    if (position === null || position === this.element.currentTime * 1_000) {
      return;
    }

    this.seekElement(position);
  }

  private seekElement(positionMilliseconds: number, { isRetry = false } = {}) {
    this.seek = { targetMilliseconds: positionMilliseconds, isRetry };
    this.element.currentTime = positionMilliseconds / 1_000;
  }

  private confirmSeek() {
    const { seek, element } = this;
    if (seek === null || element.seeking) {
      return;
    }

    const landedMilliseconds = element.currentTime * 1_000;
    if (
      Math.abs(landedMilliseconds - seek.targetMilliseconds) <= SEEK_TOLERANCE_MILLISECONDS ||
      seek.isRetry
    ) {
      this.seek = null;
      return;
    }

    this.seekElement(seek.targetMilliseconds, { isRetry: true });
  }

  private readPosition() {
    return (
      this.pendingPositionMilliseconds ??
      this.seek?.targetMilliseconds ??
      Math.round(this.element.currentTime * 1_000)
    );
  }

  private save(when: "now" | "if-due", positionMilliseconds: number) {
    if (when === "now") {
      void this.session.save(positionMilliseconds);
    } else {
      void this.session.saveIfDue(positionMilliseconds);
    }
  }

  private readSnapshot(): PlayerSnapshot {
    const { element } = this;
    const positionMilliseconds = this.readPosition();
    const isPlaying = isElementPlaying(element);

    return {
      currentUnitIndex: findUnitIndexAt(this.session.timeline, positionMilliseconds),
      positionMilliseconds,
      durationMilliseconds:
        Number.isFinite(element.duration) && element.duration > 0
          ? Math.round(element.duration * 1_000)
          : this.session.timeline.durationMilliseconds,
      isPlaying,
      isBuffering: isPlaying && element.readyState < HAVE_FUTURE_DATA,
      playbackRate: element.playbackRate,
      needsNewTrackUrl: element.error !== null,
      error:
        this.failure ??
        (element.error ? MEDIA_ERROR_MESSAGE : null) ??
        this.session.getSaveFailure(),
    };
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
}
