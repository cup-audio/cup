import { Capacitor } from "@capacitor/core";

import { createElementPlayers } from "#src/app/player/narration-track-player.js";
import {
  createNativePlayers,
  createRunningPlayerFinder,
  type NativePlayerServices,
} from "#src/app/player/native-track-player.js";
import {
  PlaybackSession,
  type PlaybackSessionRequest,
  type PlaybackSessionServices,
} from "#src/app/player/playback-session.js";
import type { CreatePlayer, FindRunningPlayer } from "#src/app/player/player.js";
import { cachePlaybackPosition, savePlaybackPosition } from "#src/data-fetching/reader.js";
import { mediaPlaybackPlugin } from "#src/platform/media-playback.android.js";

/** Connects a loaded audiobook's playback session to position storage. */
export function createPlaybackSession(request: PlaybackSessionRequest): PlaybackSession {
  const services: PlaybackSessionServices = {
    savePosition: (position, subject) =>
      savePlaybackPosition(request.conversionId, position, subject),
    now: () => Date.now(),
    setRetryTimer: (callback, delayMilliseconds) => {
      const timeout = setTimeout(callback, delayMilliseconds);
      return () => clearTimeout(timeout);
    },
    onReconnect: listenForReconnect,
  };
  return new PlaybackSession(request, services);
}

/**
 * The players of the platform: the Android app's native ExoPlayer, whose session can outlive the
 * page, or one `<audio>` element in browsers and the iOS app, where nothing plays when the page
 * starts. The element sets no `crossOrigin`: the narration track's signed URL carries its own
 * authorization, so the request needs no cookie.
 */
export function createPlatformPlayers(): {
  createPlayer: CreatePlayer;
  findRunningPlayer: FindRunningPlayer;
} {
  if (Capacitor.getPlatform() !== "android") {
    return {
      createPlayer: createElementPlayers(new Audio()),
      findRunningPlayer: () => Promise.resolve(null),
    };
  }

  const services: NativePlayerServices = {
    now: () => Date.now(),
    setInterval: (callback, intervalMilliseconds) => {
      const interval = setInterval(callback, intervalMilliseconds);
      return () => clearInterval(interval);
    },
    onVisible: (callback) => {
      const handleVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          callback();
        }
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);
      return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
    },
    cachePosition: cachePlaybackPosition,
  };
  return {
    createPlayer: createNativePlayers(mediaPlaybackPlugin, services),
    findRunningPlayer: createRunningPlayerFinder(mediaPlaybackPlugin, services),
  };
}

/**
 * Calls `callback` when the connection may be back: the device went online, or the app returned to
 * the foreground. Android can cut a backgrounded app's network access, so a save sent while the app
 * was in the background or the screen was locked can fail to resolve the API host (CUP-71).
 */
function listenForReconnect(callback: () => void): () => void {
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      callback();
    }
  };
  globalThis.addEventListener("online", callback);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  return () => {
    globalThis.removeEventListener("online", callback);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
