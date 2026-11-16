import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import type {
  MediaMetadataInput,
  MediaPlaybackStateInput,
  MediaPositionStateInput,
  MediaSessionActionHandlers,
  MediaSessionPort,
} from "#src/platform/media-session.ts";

/** What the system's media controls ask of the loaded audiobook, through the native session. */
type MediaSessionCommand =
  | { action: "play" | "pause" | "stop" }
  | { action: "seekto"; positionMilliseconds: number }
  | { action: "seekbackward" | "seekforward"; offsetMilliseconds: number };

/**
 * The Android shell's media session plugin (`MediaSessionPlugin.java`), which mirrors what the page
 * reports in a Media3 session and sends the system's commands back. It never touches the
 * `<audio>`.
 */
type CupMediaSessionPlugin = {
  setMetadata(options: MediaMetadataInput): Promise<void>;
  setPlaybackState(options: MediaPlaybackStateInput): Promise<void>;
  setPositionState(options: MediaPositionStateInput): Promise<void>;
  clear(): Promise<void>;
  addListener(
    eventName: "command",
    listener: (command: MediaSessionCommand) => void,
  ): Promise<PluginListenerHandle>;
};

const plugin = registerPlugin<CupMediaSessionPlugin>("CupMediaSession");
/** The loaded audiobook's handlers; `null` while nothing is loaded, which drops late commands. */
let handlers: MediaSessionActionHandlers | null = null;
let isListening = false;

/** The media session port over the Android shell's plugin, since Android WebView has none. */
export const mediaSession: MediaSessionPort = {
  setMetadata({ title, artworkUrl }) {
    send(plugin.setMetadata({ title, artworkUrl }));
  },

  setPlaybackState({ playbackState, isWaiting, hasEnded }) {
    send(plugin.setPlaybackState({ playbackState, isWaiting, hasEnded }));
  },

  setPositionState({ durationMilliseconds, positionMilliseconds, playbackRate }) {
    send(plugin.setPositionState({ durationMilliseconds, positionMilliseconds, playbackRate }));
  },

  setActionHandlers(nextHandlers) {
    handlers = nextHandlers;
    // One listener for the app's lifetime, which dispatches to whichever audiobook is loaded.
    if (!isListening) {
      isListening = true;
      send(plugin.addListener("command", handleCommand));
    }
  },

  clear() {
    handlers = null;
    send(plugin.clear());
  },
};

function handleCommand(command: MediaSessionCommand) {
  if (!handlers) {
    return;
  }

  switch (command.action) {
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
      handlers.seekTo(command.positionMilliseconds);
      break;
    }
    case "seekbackward": {
      handlers.seekBackward(command.offsetMilliseconds);
      break;
    }
    case "seekforward": {
      handlers.seekForward(command.offsetMilliseconds);
      break;
    }
    default: {
      throw new Error(`Unexpected media session command ${JSON.stringify(command)}.`);
    }
  }
}

/** The system's media controls are best effort: a failed report must not break playback. */
function send(call: Promise<unknown>) {
  call.catch((error: unknown) => {
    console.error("The media session plugin rejected a call.", error);
  });
}
