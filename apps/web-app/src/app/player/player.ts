import type { NarrationTrack } from "@cup/listener-api.routes";

import type { PlaybackSession } from "#src/app/player/playback-session.ts";

export type PlayerSnapshot = {
  currentUnitIndex: number;
  positionMilliseconds: number;
  durationMilliseconds: number;
  isPlaying: boolean;
  isBuffering: boolean;
  playbackRate: number;
  needsNewTrackUrl: boolean;
  error: string | null;
};

export type PlaybackChange = {
  hasEnded: boolean;
};

export type Player = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => PlayerSnapshot;
  subscribePlaybackChanges: (listener: (change: PlaybackChange) => void) => () => void;
  play: () => void;
  pause: () => void;
  seekToUnit: (unitIndex: number) => void;
  seekTo: (positionMilliseconds: number) => void;
  skipBy: (deltaMilliseconds: number) => void;
  replaceUrls: (narrationTrack: NarrationTrack, urlsReceivedAt: number) => void;
  showError: (message: string) => void;
  close: (position: PositionOnClose, ending: PlayerEnding) => void;
};

export type PositionOnClose = "save" | "discard";

export type PlayerEnding = "unload" | "replace";

export type CreatePlayer = (session: PlaybackSession, urlsReceivedAt: number) => Player;

export type RunningPlayer = {
  conversionId: string;
  subject: string;
  adopt: (session: PlaybackSession) => Player;
  discard: () => void;
};

export type FindRunningPlayer = () => Promise<RunningPlayer | null>;

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
