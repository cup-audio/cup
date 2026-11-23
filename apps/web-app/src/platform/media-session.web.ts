import type { MediaSessionActionHandlers, MediaSessionPort } from "#src/platform/media-session.ts";

const ACTIONS = [
  "play",
  "pause",
  "stop",
  "seekto",
  "seekbackward",
  "seekforward",
] as const satisfies readonly MediaSessionAction[];

export const mediaSession: MediaSessionPort = {
  setMetadata({ title, artworkUrl }) {
    const session = readMediaSession();
    if (!session) {
      return;
    }

    session.metadata = new MediaMetadata({
      title,
      artwork: artworkUrl === undefined ? [] : [{ src: artworkUrl }],
    });
  },

  setPlaybackState({ playbackState, isWaiting }) {
    const session = readMediaSession();
    if (!session) {
      return;
    }

    session.playbackState = isWaiting ? "paused" : playbackState;
  },

  setPositionState({ durationMilliseconds, positionMilliseconds, playbackRate }) {
    readMediaSession()?.setPositionState({
      duration: durationMilliseconds / 1_000,
      position: positionMilliseconds / 1_000,
      playbackRate,
    });
  },

  setActionHandlers(handlers) {
    const session = readMediaSession();
    if (!session) {
      return;
    }

    for (const action of ACTIONS) {
      session.setActionHandler(action, (details) => handleAction(handlers, details));
    }
  },

  clear() {
    const session = readMediaSession();
    if (!session) {
      return;
    }

    session.metadata = null;
    session.playbackState = "none";
    session.setPositionState();
    for (const action of ACTIONS) {
      session.setActionHandler(action, null);
    }
  },
};

function readMediaSession(): MediaSession | null {
  return "mediaSession" in navigator ? navigator.mediaSession : null;
}

function handleAction(handlers: MediaSessionActionHandlers, details: MediaSessionActionDetails) {
  switch (details.action) {
    case "play": {
      handlers.play();
      break;
    }
    case "pause": {
      handlers.pause();
      break;
    }
    case "stop": {
      handlers.stop();
      break;
    }
    case "seekto": {
      if (details.seekTime !== undefined) {
        handlers.seekTo(details.seekTime * 1_000);
      }
      break;
    }
    case "seekbackward": {
      handlers.seekBackward(toMilliseconds(details.seekOffset));
      break;
    }
    case "seekforward": {
      handlers.seekForward(toMilliseconds(details.seekOffset));
      break;
    }
    default: {
      throw new Error(`Unexpected media session action ${details.action}.`);
    }
  }
}

function toMilliseconds(seconds: number | undefined) {
  return seconds === undefined ? undefined : seconds * 1_000;
}
