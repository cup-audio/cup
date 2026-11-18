import type { Audiobook, PlaybackPosition } from "@cup/listener-api.routes";

import {
  createNativePlayers,
  createRunningPlayerFinder,
  type MediaPlaybackPlugin,
  type NativePlaybackState,
} from "#src/app/player/native-track-player.ts";
import { PlaybackSession, type PlayableAudiobook } from "#src/app/player/playback-session.ts";
import { PlayerHost, type PlayerHostAccount } from "#src/app/player/player-host.ts";
import { SAVE_RETRY_FAILURE_MESSAGE } from "#src/app/player/position-saves-machine.ts";
import type { MediaSessionPort } from "#src/platform/media-session.ts";
import { expect, test } from "#src/test-utils/component-test.ts";

/** On Android the native player's own Media3 session reports to the system. */
const NO_MEDIA_SESSION: MediaSessionPort = {
  setMetadata: () => undefined,
  setPlaybackState: () => undefined,
  setPositionState: () => undefined,
  setActionHandlers: () => undefined,
  clear: () => undefined,
};
const MEDIA_ERROR_MESSAGE = "Audio could not be played. Press Play to try again.";
const TWELVE_HOURS_MILLISECONDS = 12 * 60 * 60 * 1_000;

/**
 * The Android app's media playback plugin, as far as the page sees it: it records the commands it
 * receives, and tests emit the `state` events ExoPlayer's changes would send.
 */
class FakeMediaPlaybackPlugin implements MediaPlaybackPlugin {
  readonly calls: Array<{ method: string; options?: unknown }> = [];
  /** What `getState` answers, as the plugin's current state. */
  currentState: NativePlaybackState | null = null;
  /** What removing the state listener rejects with, if anything. */
  listenerRemovalError: Error | null = null;
  private stateListener: ((state: NativePlaybackState) => void) | null = null;

  load(options: unknown) {
    return this.record("load", options);
  }

  play() {
    return this.record("play");
  }

  pause() {
    return this.record("pause");
  }

  seekTo(options: unknown) {
    return this.record("seekTo", options);
  }

  skipBy(options: unknown) {
    return this.record("skipBy", options);
  }

  replaceUrls(options: unknown) {
    return this.record("replaceUrls", options);
  }

  close(options: unknown) {
    return this.record("close", options);
  }

  getState() {
    this.calls.push({ method: "getState" });
    return Promise.resolve({ state: this.currentState });
  }

  addListener(_eventName: "state", listener: (state: NativePlaybackState) => void) {
    this.stateListener = listener;
    return Promise.resolve({
      remove: () => {
        if (this.listenerRemovalError) {
          return Promise.reject(this.listenerRemovalError);
        }
        if (this.stateListener === listener) {
          this.stateListener = null;
        }
        return Promise.resolve();
      },
    });
  }

  /** ExoPlayer changed; the plugin reports its state. */
  emit(state: NativePlaybackState) {
    this.currentState = state;
    this.stateListener?.(state);
  }

  /** The commands sent, without `getState`. */
  commands() {
    return this.calls.filter(({ method }) => method !== "getState");
  }

  private record(method: string, options?: unknown) {
    this.calls.push(options === undefined ? { method } : { method, options });
    return Promise.resolve();
  }
}

const UNITS = [
  { id: "unit-1", narrationText: "One" },
  { id: "unit-2", narrationText: "Two" },
  { id: "unit-3", narrationText: "Three" },
];

function createAudiobook(
  title: string,
  playbackPosition: PlaybackPosition | null = null,
): PlayableAudiobook {
  return {
    status: "ready",
    canGenerate: true,
    playbackPosition,
    title,
    originalUrl: "https://source.example.test/fixture",
    narrationDocument: { html: "<article></article>", synchronizationUnits: UNITS },
    segments: UNITS.map((_unit, sequence) => ({ sequence, status: "ready" as const })),
    coverImage: { url: `https://example.com/${title}/cover?token=fixture` },
    // Units of 4, 6 and 5 seconds.
    narrationTrack: {
      url: `https://example.com/${title}/narration-track.mp3?token=fixture`,
      positionUrl: `https://example.com/api/audiobooks/${title}/position?token=fixture`,
      durationMilliseconds: 15_000,
      startMilliseconds: [0, 4_000, 10_000],
    },
  };
}

const FIRST = createAudiobook("First", {
  synchronizationUnitId: "unit-2",
  offsetMilliseconds: 1_500,
});
const SECOND = createAudiobook("Second");
const RENEWED_TRACK_URL = "https://example.com/First/narration-track.mp3?token=renewed";
const RENEWED_POSITION_URL = "https://example.com/api/audiobooks/first/position?token=renewed";
const RENEWED_TRACK = {
  ...FIRST.narrationTrack,
  url: RENEWED_TRACK_URL,
  positionUrl: RENEWED_POSITION_URL,
};

function createHost({
  subject = "user-1",
  initialAccount = { status: "known", subject },
  fetchAudiobook = (conversionId) =>
    Promise.reject(new Error(`Unexpected fetch of audiobook ${conversionId}.`)),
}: {
  subject?: string | null;
  initialAccount?: PlayerHostAccount;
  fetchAudiobook?: (conversionId: string) => Promise<Audiobook | null>;
} = {}) {
  const plugin = new FakeMediaPlaybackPlugin();
  const saved: PlaybackPosition[] = [];
  const clock = { now: 1_000_000 };
  /** The ticks that move a playing position on, which tests run in place of the timer. */
  const ticks = new Set<() => void>();
  /** The page became visible again, which tests trigger in place of `visibilitychange`. */
  const visibility = new Set<() => void>();
  /** The audiobooks the host fetched. */
  const fetched: string[] = [];
  /** The listening positions written into the cached audiobooks, as `conversion unit+offset`. */
  const cached: string[] = [];
  let account = initialAccount;
  const nativeServices = {
    now: () => clock.now,
    cachePosition: (conversionId: string, position: PlaybackPosition) => {
      cached.push(
        `${conversionId} ${position.synchronizationUnitId}+${position.offsetMilliseconds}`,
      );
    },
    setInterval: (callback: () => void) => {
      ticks.add(callback);
      return () => ticks.delete(callback);
    },
    onVisible: (callback: () => void) => {
      visibility.add(callback);
      return () => visibility.delete(callback);
    },
  };

  const host = new PlayerHost({
    createPlayer: createNativePlayers(plugin, nativeServices),
    findRunningPlayer: createRunningPlayerFinder(plugin, nativeServices),
    createSession: (request) =>
      new PlaybackSession(request, {
        savePosition: (position) => {
          saved.push(position);
          return Promise.resolve();
        },
        now: () => clock.now,
        setRetryTimer: () => () => undefined,
        onReconnect: () => () => undefined,
      }),
    mediaSession: NO_MEDIA_SESSION,
    getAccount: () => account,
    getLocalPosition: () => null,
    fetchAudiobook: (conversionId) => {
      fetched.push(conversionId);
      return fetchAudiobook(conversionId);
    },
    now: () => clock.now,
  });
  host.accountChanged();
  const setAccount = (value: PlayerHostAccount) => {
    account = value;
    host.accountChanged();
  };
  const player = () => {
    const loaded = host.getSnapshot().loaded;
    if (!loaded) {
      throw new Error("Expected a loaded audiobook.");
    }
    return loaded.player;
  };
  const tick = () => {
    for (const callback of ticks) {
      callback();
    }
  };
  const becomeVisible = () => {
    for (const callback of visibility) {
      callback();
    }
  };

  return {
    host,
    plugin,
    player,
    saved,
    cached,
    fetched,
    clock,
    setAccount,
    tick,
    ticks,
    becomeVisible,
  };
}

/** A state the plugin reports for the first audiobook, read at `positionReadAt`. */
function stateOf(state: Partial<NativePlaybackState> = {}): NativePlaybackState {
  return {
    conversionId: "first",
    subject: "user-1",
    isPlaying: false,
    isBuffering: false,
    hasEnded: false,
    durationMilliseconds: 15_000,
    positionMilliseconds: 0,
    positionReadAt: 1_000_000,
    error: null,
    closedReason: null,
    positionSave: { status: "ok" },
    ...state,
  };
}

/** Lets settled plugin calls run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("loading the shown audiobook sets it in the plugin at its listening position, without playing", () => {
  const { host, plugin, player } = createHost();
  host.showConversion("first", FIRST);

  host.loadShown();

  expect(plugin.commands()).toEqual([
    {
      method: "load",
      options: {
        conversionId: "first",
        subject: "user-1",
        trackUrl: "https://example.com/First/narration-track.mp3?token=fixture",
        positionUrl: "https://example.com/api/audiobooks/First/position?token=fixture",
        // The page received the URLs with the audiobook, when it showed it.
        urlsIssuedAt: 1_000_000,
        // The plugin saves listening positions, which it converts with each unit's start.
        timeline: [
          { synchronizationUnitId: "unit-1", startMilliseconds: 0 },
          { synchronizationUnitId: "unit-2", startMilliseconds: 4_000 },
          { synchronizationUnitId: "unit-3", startMilliseconds: 10_000 },
        ],
        title: "First",
        artworkUrl: "https://example.com/First/cover?token=fixture",
        durationMilliseconds: 15_000,
        startPositionMilliseconds: 5_500,
      },
    },
  ]);
  expect(player().getSnapshot()).toMatchObject({
    currentUnitIndex: 1,
    positionMilliseconds: 5_500,
    durationMilliseconds: 15_000,
    isPlaying: false,
    error: null,
  });
});

test("the native player refuses a listener without an account, since only signed-in listeners play in the app", () => {
  const { host } = createHost({ subject: null });
  host.showConversion("first", FIRST);

  expect(() => host.loadShown()).toThrow(/signed-in/u);
});

test("Play, Pause, a seek and the skips go to the plugin, and the player shows them before it reports", () => {
  const { host, plugin, player } = createHost();
  host.showConversion("first", FIRST);
  host.loadShown();

  host.play();
  expect(player().getSnapshot()).toMatchObject({ isPlaying: true, isBuffering: true });
  host.togglePlayback();
  expect(player().getSnapshot()).toMatchObject({ isPlaying: false, positionMilliseconds: 5_500 });
  player().seekTo(20_000);
  expect(player().getSnapshot().positionMilliseconds).toBe(14_999);
  player().skipBy(-15_000);
  expect(player().getSnapshot().positionMilliseconds).toBe(0);
  host.playShown(2);

  expect(plugin.commands().slice(1)).toEqual([
    { method: "play" },
    { method: "pause" },
    { method: "seekTo", options: { positionMilliseconds: 14_999 } },
    // The plugin skips from ExoPlayer's own position, which may be ahead of the page's.
    { method: "skipBy", options: { deltaMilliseconds: -15_000 } },
    { method: "seekTo", options: { positionMilliseconds: 10_000 } },
    { method: "play" },
  ]);
  expect(player().getSnapshot()).toMatchObject({ currentUnitIndex: 2, isPlaying: true });
});

test("while the plugin reports playing, the position moves on from the time it was read", () => {
  const { host, plugin, player, clock, tick, ticks } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();

  plugin.emit(stateOf({ isPlaying: true, positionMilliseconds: 5_600, positionReadAt: clock.now }));
  clock.now += 2_500;
  tick();

  expect(player().getSnapshot()).toMatchObject({
    isPlaying: true,
    isBuffering: false,
    positionMilliseconds: 8_100,
    currentUnitIndex: 1,
  });

  // Waiting for data, the position stands still.
  plugin.emit(
    stateOf({
      isPlaying: true,
      isBuffering: true,
      positionMilliseconds: 8_100,
      positionReadAt: clock.now,
    }),
  );
  clock.now += 3_000;
  tick();
  expect(player().getSnapshot()).toMatchObject({ isBuffering: true, positionMilliseconds: 8_100 });

  plugin.emit(stateOf({ positionMilliseconds: 9_000, positionReadAt: clock.now }));
  expect(player().getSnapshot()).toMatchObject({ isPlaying: false, positionMilliseconds: 9_000 });
  expect(ticks.size).toBe(0);
});

test("the extrapolated position stops at the duration the plugin reports", () => {
  const { host, plugin, player, clock, tick } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();

  plugin.emit(
    stateOf({
      isPlaying: true,
      durationMilliseconds: 15_200,
      positionMilliseconds: 15_000,
      positionReadAt: clock.now,
    }),
  );
  clock.now += 5_000;
  tick();

  expect(player().getSnapshot()).toMatchObject({
    durationMilliseconds: 15_200,
    positionMilliseconds: 15_200,
  });
});

test("a state for another audiobook is ignored", () => {
  const { host, plugin, player } = createHost();
  host.showConversion("first", FIRST);
  host.loadShown();

  plugin.emit(stateOf({ conversionId: "second", isPlaying: true, positionMilliseconds: 1_000 }));

  expect(player().getSnapshot()).toMatchObject({ isPlaying: false, positionMilliseconds: 5_500 });
});

test("a playback error pauses with the message to press Play, and Play continues from the same position", () => {
  const { host, plugin, player } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();

  plugin.emit(stateOf({ error: "playback", positionMilliseconds: 7_000 }));
  expect(player().getSnapshot()).toMatchObject({
    isPlaying: false,
    positionMilliseconds: 7_000,
    error: MEDIA_ERROR_MESSAGE,
    needsNewTrackUrl: false,
  });

  host.togglePlayback();

  // ExoPlayer prepares the same item again where it stopped; the URL needs no renewal.
  expect(plugin.commands().at(-1)).toEqual({ method: "play" });
  expect(player().getSnapshot()).toMatchObject({ isPlaying: true, error: null });
});

test("the end returns to the start, as the plugin reports it", () => {
  const { host, plugin, player } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();

  plugin.emit(stateOf({ hasEnded: true, positionMilliseconds: 0 }));

  expect(player().getSnapshot()).toMatchObject({
    isPlaying: false,
    positionMilliseconds: 0,
    currentUnitIndex: 0,
  });
});

test("the page asks the plugin for its state when it becomes visible, since events sent while hidden can be lost", async () => {
  const { host, plugin, player, becomeVisible } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();

  plugin.currentState = stateOf({ positionMilliseconds: 12_000 });
  becomeVisible();
  await settle();

  expect(plugin.calls.at(-1)).toEqual({ method: "getState" });
  expect(player().getSnapshot()).toMatchObject({ isPlaying: false, positionMilliseconds: 12_000 });
});

test("the page saves no position on Android, where the plugin owns the listening position", async () => {
  const { host, plugin, player, saved } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();
  plugin.emit(stateOf({ isPlaying: true, positionMilliseconds: 6_000 }));

  player().seekTo(9_000);
  host.pause();
  host.unload();
  await settle();

  expect(saved).toEqual([]);
});

test("every state the plugin reports writes its listening position into the cached audiobook", () => {
  const { host, plugin, cached } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();

  plugin.emit(stateOf({ isPlaying: true, positionMilliseconds: 6_000 }));
  plugin.emit(stateOf({ positionMilliseconds: 11_500 }));
  // The last position of a native stop too, which the next Play on this page saves.
  plugin.emit(stateOf({ positionMilliseconds: 2_000, closedReason: "taskRemoved" }));

  expect(cached).toEqual(["first unit-2+2000", "first unit-3+1500", "first unit-1+2000"]);
});

test("saves that fail for a reason that can pass show plain words once the plugin reports they still fail", () => {
  const { host, plugin, player } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();

  plugin.emit(stateOf({ positionSave: { status: "failing" } }));
  expect(player().getSnapshot().error).toBeNull();

  // A retry failed too, or saves have failed for the retry delay.
  plugin.emit(stateOf({ positionSave: { status: "stillFailing" } }));
  expect(player().getSnapshot().error).toBe(SAVE_RETRY_FAILURE_MESSAGE);

  plugin.emit(stateOf({ positionSave: { status: "ok" } }));
  expect(player().getSnapshot().error).toBeNull();
});

test("a save the server refuses shows the server's words", () => {
  const { host, plugin, player } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();

  plugin.emit(stateOf({ positionSave: { status: "refused", refusal: "Audiobook not found." } }));

  expect(player().getSnapshot().error).toBe("Audiobook not found.");
});

test("a playback error shows before a failing save", () => {
  const { host, plugin, player } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();

  plugin.emit(stateOf({ error: "playback", positionSave: { status: "stillFailing" } }));

  expect(player().getSnapshot().error).toBe(MEDIA_ERROR_MESSAGE);
});

test("Play more than 12 hours after receiving the track URL renews it in the plugin, then plays", async () => {
  const { host, plugin, clock } = createHost({
    fetchAudiobook: () =>
      Promise.resolve({
        ...FIRST,
        narrationTrack: RENEWED_TRACK,
      }),
  });
  host.showConversion("first", FIRST);
  host.loadShown();

  clock.now += TWELVE_HOURS_MILLISECONDS + 1;
  host.play();
  await settle();

  expect(plugin.commands().slice(1)).toEqual([
    {
      method: "replaceUrls",
      options: {
        trackUrl: RENEWED_TRACK_URL,
        positionUrl: RENEWED_POSITION_URL,
        urlsIssuedAt: clock.now,
      },
    },
    { method: "play" },
  ]);
});

test("a change of the signed-in user closes the native session and saves its position", () => {
  const { host, plugin, setAccount } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();

  setAccount({ status: "known", subject: null });

  expect(plugin.commands().at(-1)).toEqual({ method: "close", options: { position: "save" } });
  expect(host.getSnapshot().loaded).toBeNull();
});

test("releasing an audiobook being deleted closes the native session without saving", () => {
  const { host, plugin } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();

  host.release("first");

  expect(plugin.commands().at(-1)).toEqual({ method: "close", options: { position: "discard" } });
});

test("a state listener the plugin fails to remove is reported, not left as an unhandled rejection", async () => {
  const { host, plugin } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();
  const removalError = new Error("The bridge is gone.");
  plugin.listenerRemovalError = removalError;
  const reported: unknown[][] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => reported.push(args);
  try {
    host.unload();
    await settle();
  } finally {
    console.error = consoleError;
  }

  expect(reported).toEqual([[expect.any(String), removalError]]);
});

test("loading another audiobook sets it in the running session without closing it", () => {
  const { host, plugin, player } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();
  host.hideConversion("first");
  host.showConversion("second", SECOND);

  host.loadShown();

  expect(plugin.commands().map(({ method }) => method)).toEqual(["load", "play", "load"]);
  expect(plugin.commands().at(-1)).toMatchObject({
    options: { conversionId: "second", startPositionMilliseconds: 0 },
  });
  // The first audiobook's late states no longer reach the page.
  plugin.emit(stateOf({ isPlaying: true, positionMilliseconds: 3_000 }));
  expect(player().getSnapshot()).toMatchObject({ isPlaying: false, positionMilliseconds: 0 });
});

test("after a native stop the audiobook stays loaded at the last position, and the next Play loads it again and plays", () => {
  const { host, plugin, player } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();

  // The listener swiped Cup from recents while it was paused.
  plugin.emit(stateOf({ positionMilliseconds: 8_000, closedReason: "taskRemoved" }));
  expect(player().getSnapshot()).toMatchObject({
    isPlaying: false,
    positionMilliseconds: 8_000,
    error: null,
    needsNewTrackUrl: false,
  });
  // The plugin dropped its item, so a skip only moves the position the next load starts from.
  player().skipBy(2_000);
  expect(player().getSnapshot().positionMilliseconds).toBe(10_000);
  host.play();

  expect(plugin.commands().slice(2)).toEqual([
    {
      method: "load",
      options: expect.objectContaining({
        conversionId: "first",
        trackUrl: "https://example.com/First/narration-track.mp3?token=fixture",
        urlsIssuedAt: 1_000_000,
        startPositionMilliseconds: 10_000,
      }),
    },
    { method: "play" },
  ]);
  expect(player().getSnapshot()).toMatchObject({ isPlaying: true });
});

test("expired track URLs end the native session, and the next Play renews them, then loads and plays", async () => {
  const { host, plugin, player, clock } = createHost({
    fetchAudiobook: () =>
      Promise.resolve({
        ...FIRST,
        narrationTrack: RENEWED_TRACK,
      }),
  });
  host.showConversion("first", FIRST);
  host.playShown();

  plugin.emit(
    stateOf({
      positionMilliseconds: 7_000,
      error: "trackUrlExpired",
      closedReason: "trackUrlExpired",
    }),
  );
  expect(player().getSnapshot()).toMatchObject({
    isPlaying: false,
    positionMilliseconds: 7_000,
    error: null,
    needsNewTrackUrl: true,
  });
  clock.now += 60_000;
  host.play();
  await settle();

  expect(plugin.commands().slice(2)).toEqual([
    {
      method: "load",
      options: expect.objectContaining({
        trackUrl: RENEWED_TRACK_URL,
        positionUrl: RENEWED_POSITION_URL,
        urlsIssuedAt: clock.now,
        startPositionMilliseconds: 7_000,
      }),
    },
    { method: "play" },
  ]);
});

test("a native stop the hidden page missed shows once the page becomes visible", async () => {
  const { host, plugin, player, becomeVisible } = createHost();
  host.showConversion("first", FIRST);
  host.playShown();

  plugin.currentState = stateOf({
    positionMilliseconds: 12_000,
    closedReason: "notificationDismissed",
  });
  becomeVisible();
  await settle();
  expect(player().getSnapshot()).toMatchObject({ isPlaying: false, positionMilliseconds: 12_000 });
  host.play();

  expect(
    plugin
      .commands()
      .slice(2)
      .map(({ method }) => method),
  ).toEqual(["load", "play"]);
});

test("a page that starts while the plugin plays the listener's audiobook takes the session over without loading it again", async () => {
  const { host, plugin, player, fetched, clock } = createHost({
    fetchAudiobook: () => Promise.resolve(FIRST),
  });
  plugin.currentState = stateOf({
    isPlaying: true,
    positionMilliseconds: 9_000,
    positionReadAt: clock.now,
  });

  await host.adoptRunningPlayer();

  expect(fetched).toEqual(["first"]);
  expect(host.getSnapshot().loaded).toMatchObject({ conversionId: "first", subject: "user-1" });
  expect(plugin.commands()).toEqual([]);
  // The page shows the plugin's position, not the account's.
  expect(player().getSnapshot()).toMatchObject({ isPlaying: true, positionMilliseconds: 9_000 });
  host.togglePlayback();
  expect(plugin.commands()).toEqual([{ method: "pause" }]);
});

test("the first Play after taking a session over renews its URLs, whose age the page does not know", async () => {
  const { host, plugin, clock } = createHost({
    fetchAudiobook: () =>
      Promise.resolve({
        ...FIRST,
        narrationTrack: RENEWED_TRACK,
      }),
  });
  plugin.currentState = stateOf({ positionMilliseconds: 9_000 });
  await host.adoptRunningPlayer();

  host.play();
  await settle();

  expect(plugin.commands()).toEqual([
    {
      method: "replaceUrls",
      options: {
        trackUrl: RENEWED_TRACK_URL,
        positionUrl: RENEWED_POSITION_URL,
        urlsIssuedAt: clock.now,
      },
    },
    { method: "play" },
  ]);
});

test("a page that starts while the plugin plays a deleted audiobook closes the session", async () => {
  const { host, plugin } = createHost({ fetchAudiobook: () => Promise.resolve(null) });
  plugin.currentState = stateOf({ isPlaying: true });

  await host.adoptRunningPlayer();

  expect(host.getSnapshot().loaded).toBeNull();
  expect(plugin.commands()).toEqual([{ method: "close", options: { position: "discard" } }]);
});

test("a page that starts while the plugin plays another account's audiobook closes the session without fetching it", async () => {
  const { host, plugin, fetched } = createHost();
  plugin.currentState = stateOf({ subject: "user-2", isPlaying: true });

  await host.adoptRunningPlayer();

  expect(fetched).toEqual([]);
  expect(host.getSnapshot().loaded).toBeNull();
  expect(plugin.commands()).toEqual([{ method: "close", options: { position: "discard" } }]);
});

test("taking a session over waits until the stored account is restored", async () => {
  const { host, plugin, setAccount } = createHost({
    initialAccount: { status: "restoring" },
    fetchAudiobook: () => Promise.resolve(FIRST),
  });
  plugin.currentState = stateOf({ isPlaying: true });

  const adoption = host.adoptRunningPlayer();
  await settle();
  expect(host.getSnapshot().loaded).toBeNull();
  setAccount({ status: "known", subject: "user-1" });
  await adoption;

  expect(host.getSnapshot().loaded).toMatchObject({ conversionId: "first" });
  expect(plugin.commands()).toEqual([]);
});

test("a page that starts after a native stop has no session to take over", async () => {
  const { host, plugin, fetched } = createHost();
  plugin.currentState = stateOf({ closedReason: "taskRemoved" });

  await host.adoptRunningPlayer();

  expect(fetched).toEqual([]);
  expect(host.getSnapshot().loaded).toBeNull();
  expect(plugin.commands()).toEqual([]);
});
