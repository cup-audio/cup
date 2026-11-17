import type { NarrationTrack } from "@cup/listener-api.routes";

import type { PlaybackSession } from "#src/app/player/playback-session.ts";

/** The loaded audiobook's playback, on the whole-audiobook timeline. */
export type PlayerSnapshot = {
  currentUnitIndex: number;
  positionMilliseconds: number;
  durationMilliseconds: number;
  isPlaying: boolean;
  isBuffering: boolean;
  playbackRate: number;
  /** The track could not be loaded from its URL; Play must renew the URL first. */
  needsNewTrackUrl: boolean;
  error: string | null;
};

/** A change of playback that the system's media controls must hear of, unlike a time update. */
export type PlaybackChange = {
  /** The audiobook reached its end, and the player returned to its start. */
  hasEnded: boolean;
};

/**
 * Plays one loaded audiobook, whatever the engine: the browser's `<audio>`, or the Android app's
 * native player. The player host creates one per load through `PlayerHostServices.createPlayer`.
 */
export type Player = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => PlayerSnapshot;
  /** Calls the listener after a play, pause, seek, rate change, wait for data, or the end. */
  subscribePlaybackChanges: (listener: (change: PlaybackChange) => void) => () => void;
  /** Must be called from a user gesture: browsers only then allow audio to start. */
  play: () => void;
  pause: () => void;
  seekToUnit: (unitIndex: number) => void;
  seekTo: (positionMilliseconds: number) => void;
  /** Seeks by an amount from the current position, back when negative, such as −15 s and +15 s. */
  skipBy: (deltaMilliseconds: number) => void;
  /**
   * Loads the same track from the newly signed URLs of a narration track, which the client received
   * at `urlsReceivedAt`, keeping the position; plays nothing.
   */
  replaceUrls: (narrationTrack: NarrationTrack, urlsReceivedAt: number) => void;
  /** Shows a failure that happened outside the player, until the next Play. */
  showError: (message: string) => void;
  /**
   * Stops the player for good, saving the position unless told otherwise. `"unload"` also ends what
   * plays the track, the element's source or the native media session; `"replace"` leaves that to
   * the next player, which loads another audiobook into it.
   */
  close: (position: PositionOnClose, ending: PlayerEnding) => void;
};

/** `"discard"` skips saving the position, for a track that is deleted or no longer exists. */
export type PositionOnClose = "save" | "discard";

/** Whether another player follows the closed one. */
export type PlayerEnding = "unload" | "replace";

/**
 * Builds the player for a newly loaded audiobook, given its playback session and when the client
 * received the audiobook whose signed URLs it loads.
 */
export type CreatePlayer = (session: PlaybackSession, urlsReceivedAt: number) => Player;

/**
 * What already plays an audiobook when the page starts: the Android app's native session after a
 * reload, a renderer crash, a live update or a relaunch.
 */
export type RunningPlayer = {
  conversionId: string;
  /** The signed-in user it was loaded for. */
  subject: string;
  /** Becomes the loaded audiobook's player without interrupting what plays. */
  adopt: (session: PlaybackSession) => Player;
  /** Ends it without saving, for an audiobook the page cannot take over. */
  discard: () => void;
};

/** Resolves to what already plays when the page starts, or `null`, as in every browser. */
export type FindRunningPlayer = () => Promise<RunningPlayer | null>;

/** How far the −15 s and +15 s controls skip. */
export const SKIP_MILLISECONDS = 15_000;

export const MEDIA_ERROR_MESSAGE = "Audio could not be played. Press Play to try again.";

export function isSameSnapshot(left: PlayerSnapshot, right: PlayerSnapshot) {
  return (
    left.currentUnitIndex === right.currentUnitIndex &&
    left.positionMilliseconds === right.positionMilliseconds &&
    left.durationMilliseconds === right.durationMilliseconds &&
    left.isPlaying === right.isPlaying &&
    left.isBuffering === right.isBuffering &&
    left.playbackRate === right.playbackRate &&
    left.needsNewTrackUrl === right.needsNewTrackUrl &&
    left.error === right.error
  );
}
