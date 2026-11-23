import type { mediaSession } from "#src/platform/media-session.web.ts";
import { expect, test } from "#src/test-utils/component-test.ts";

test("the browser's media session shows the audiobook, sends its actions, and clearing removes all of it", async ({
  mount,
  page,
}) => {
  await mount("routes/index/LandingPage");

  const result = await page.evaluate(async () => {
    const { mediaSession: session } = navigator;
    const positionStates: Array<MediaPositionState | undefined> = [];
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler>();
    session.setPositionState = (state) => positionStates.push(state);
    session.setActionHandler = (action, handler) => {
      if (handler) {
        handlers.set(action, handler);
      } else {
        handlers.delete(action);
      }
    };
    const modulePath = "/src/platform/media-session.web.ts";
    const module: { mediaSession: typeof mediaSession } = await import(modulePath);
    const port = module.mediaSession;

    const actions: string[] = [];
    port.setMetadata({ title: "A title", artworkUrl: "https://example.com/cover?token=fixture" });
    port.setActionHandlers({
      play: () => actions.push("play"),
      pause: () => actions.push("pause"),
      stop: () => actions.push("stop"),
      seekTo: (position) => actions.push(`seekTo:${position}`),
      seekBackward: (offset) => actions.push(`seekBackward:${offset}`),
      seekForward: (offset) => actions.push(`seekForward:${offset}`),
    });
    port.setPositionState({
      durationMilliseconds: 15_000,
      positionMilliseconds: 5_500,
      playbackRate: 1.5,
    });
    port.setPlaybackState({ playbackState: "playing", isWaiting: false, hasEnded: false });
    const playing = session.playbackState;
    port.setPlaybackState({ playbackState: "playing", isWaiting: true, hasEnded: false });
    const waiting = session.playbackState;
    port.setPlaybackState({ playbackState: "paused", isWaiting: false, hasEnded: false });
    const paused = session.playbackState;
    const published = {
      title: session.metadata?.title,
      artwork: session.metadata?.artwork.map((image) => image.src),
      actions: [...handlers.keys()],
    };

    const call = (action: MediaSessionAction, details: Partial<MediaSessionActionDetails> = {}) =>
      handlers.get(action)?.({ action, ...details });
    call("play");
    call("pause");
    call("stop");
    call("seekto", { seekTime: 7.25 });
    call("seekbackward", { seekOffset: 10 });
    call("seekbackward");
    call("seekforward", { seekOffset: 30 });
    call("seekforward");

    port.clear();
    const cleared = {
      metadata: session.metadata,
      playbackState: session.playbackState,
      actions: [...handlers.keys()],
    };

    port.setMetadata({ title: "Without a cover", artworkUrl: undefined });
    const withoutCover = session.metadata?.artwork.length;

    return { published, playing, waiting, paused, positionStates, actions, cleared, withoutCover };
  });

  expect(result).toEqual({
    published: {
      title: "A title",
      artwork: ["https://example.com/cover?token=fixture"],
      actions: ["play", "pause", "stop", "seekto", "seekbackward", "seekforward"],
    },
    playing: "playing",
    waiting: "paused",
    paused: "paused",
    positionStates: [{ duration: 15, position: 5.5, playbackRate: 1.5 }, undefined],
    actions: [
      "play",
      "pause",
      "stop",
      "seekTo:7250",
      "seekBackward:10000",
      "seekBackward:undefined",
      "seekForward:30000",
      "seekForward:undefined",
    ],
    cleared: { metadata: null, playbackState: "none", actions: [] },
    withoutCover: 0,
  });
});
