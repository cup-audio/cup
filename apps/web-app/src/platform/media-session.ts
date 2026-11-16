import * as web from "#src/platform/media-session.web.js";

/** What the system's media controls show for the loaded audiobook. */
export type MediaMetadataInput = { title: string; artworkUrl: string | undefined };

/** Whether the loaded audiobook plays, as the system's media controls show it. */
export type MediaPlaybackStateInput = {
  playbackState: "playing" | "paused";
  /**
   * The element plays but waits for data, between `waiting` and `playing`. The system must not move
   * the position forward meanwhile.
   */
  isWaiting: boolean;
};

/** Where the loaded audiobook is, from which the system extrapolates the position while it plays. */
export type MediaPositionStateInput = {
  durationMilliseconds: number;
  /** At most `durationMilliseconds`. */
  positionMilliseconds: number;
  playbackRate: number;
};

/** What the system's media controls ask of the loaded audiobook. */
export type MediaSessionActionHandlers = {
  play: () => void;
  pause: () => void;
  stop: () => void;
  seekTo: (positionMilliseconds: number) => void;
  /** `offsetMilliseconds` is the system's own skip interval, `undefined` when it sends none. */
  seekBackward: (offsetMilliseconds: number | undefined) => void;
  seekForward: (offsetMilliseconds: number | undefined) => void;
};

/**
 * The system's media controls for the loaded audiobook: the lock screen, the notification, media
 * keys, headsets and earbuds. The player host reports to it and receives its actions.
 */
export type MediaSessionPort = {
  setMetadata: (metadata: MediaMetadataInput) => void;
  setPlaybackState: (state: MediaPlaybackStateInput) => void;
  setPositionState: (state: MediaPositionStateInput) => void;
  setActionHandlers: (handlers: MediaSessionActionHandlers) => void;
  /** Removes the metadata, the position state and the handlers, and sets the state to none. */
  clear: () => void;
};

/** Browsers and iOS share the `navigator.mediaSession` implementation. */
export const mediaSession: MediaSessionPort = web.mediaSession;
