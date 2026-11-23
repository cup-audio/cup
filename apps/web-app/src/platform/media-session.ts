import { Capacitor } from "@capacitor/core";

import * as web from "#src/platform/media-session.web.js";

export type MediaMetadataInput = { title: string; artworkUrl: string | undefined };

export type MediaPlaybackStateInput = {
  playbackState: "playing" | "paused";
  isWaiting: boolean;
  hasEnded: boolean;
};

export type MediaPositionStateInput = {
  durationMilliseconds: number;
  positionMilliseconds: number;
  playbackRate: number;
};

export type MediaSessionActionHandlers = {
  play: () => void;
  pause: () => void;
  stop: () => void;
  seekTo: (positionMilliseconds: number) => void;
  seekBackward: (offsetMilliseconds: number | undefined) => void;
  seekForward: (offsetMilliseconds: number | undefined) => void;
};

export type MediaSessionPort = {
  setMetadata: (metadata: MediaMetadataInput) => void;
  setPlaybackState: (state: MediaPlaybackStateInput) => void;
  setPositionState: (state: MediaPositionStateInput) => void;
  setActionHandlers: (handlers: MediaSessionActionHandlers) => void;
  clear: () => void;
};

export const noMediaSession: MediaSessionPort = {
  setMetadata: () => undefined,
  setPlaybackState: () => undefined,
  setPositionState: () => undefined,
  setActionHandlers: () => undefined,
  clear: () => undefined,
};

export const mediaSession: MediaSessionPort =
  Capacitor.getPlatform() === "android" ? noMediaSession : web.mediaSession;
