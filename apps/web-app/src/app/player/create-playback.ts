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
    onVisible: listenForVisible,
    cachePosition: cachePlaybackPosition,
  };
  return {
    createPlayer: createNativePlayers(mediaPlaybackPlugin, services),
    findRunningPlayer: createRunningPlayerFinder(mediaPlaybackPlugin, services),
  };
}

function listenForReconnect(callback: () => void): () => void {
  globalThis.addEventListener("online", callback);
  const stopListeningForVisible = listenForVisible(callback);
  return () => {
    globalThis.removeEventListener("online", callback);
    stopListeningForVisible();
  };
}

function listenForVisible(callback: () => void): () => void {
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      callback();
    }
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
}
