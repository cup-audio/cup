import type { mediaSession } from "#src/platform/media-session.ts";
import { expect, test } from "#src/test-utils/component-test.ts";

test("on Android, the reports reach the media session plugin, and its commands reach the handlers until clearing", async ({
  mount,
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      androidBridge: {},
      Capacitor: {
        PluginHeaders: [
          {
            name: "CupMediaSession",
            methods: [
              { name: "setMetadata", rtype: "promise" },
              { name: "setPlaybackState", rtype: "promise" },
              { name: "setPositionState", rtype: "promise" },
              { name: "clear", rtype: "promise" },
              { name: "addListener" },
            ],
          },
        ],
        nativePromise: (plugin: string, method: string, options: unknown) => {
          window.dispatchEvent(
            new CustomEvent("test-plugin-call", { detail: { plugin, method, options } }),
          );
          return Promise.resolve();
        },
        nativeCallback: (
          plugin: string,
          method: string,
          options: unknown,
          listener: (command: unknown) => void,
        ) => {
          window.dispatchEvent(
            new CustomEvent("test-plugin-call", { detail: { plugin, method, options } }),
          );
          window.addEventListener("test-command", (event) => {
            if (event instanceof CustomEvent) {
              listener(event.detail);
            }
          });
          return "command-listener";
        },
      },
    });
  });
  await mount("routes/index/LandingPage");

  const result = await page.evaluate(async () => {
    const calls: unknown[] = [];
    window.addEventListener("test-plugin-call", (event) => {
      if (event instanceof CustomEvent) {
        calls.push(event.detail);
      }
    });
    // The platform module picks the Android implementation.
    const modulePath = "/src/platform/media-session.ts";
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
    port.setPlaybackState({ playbackState: "playing", isWaiting: true, hasEnded: false });
    port.setPlaybackState({ playbackState: "paused", isWaiting: false, hasEnded: true });
    port.setMetadata({ title: "Without a cover", artworkUrl: undefined });
    // The listener is registered asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 50));

    for (const command of [
      { action: "play" },
      { action: "pause" },
      { action: "stop" },
      { action: "seekto", positionMilliseconds: 7_250 },
      { action: "seekbackward", offsetMilliseconds: 15_000 },
      { action: "seekforward", offsetMilliseconds: 15_000 },
    ]) {
      window.dispatchEvent(new CustomEvent("test-command", { detail: command }));
    }

    port.clear();
    // A command already on its way when the audiobook was unloaded controls nothing.
    window.dispatchEvent(new CustomEvent("test-command", { detail: { action: "play" } }));

    // Loading another audiobook registers no second listener.
    port.setActionHandlers({
      play: () => actions.push("play again"),
      pause: () => {},
      stop: () => {},
      seekTo: () => {},
      seekBackward: () => {},
      seekForward: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    window.dispatchEvent(new CustomEvent("test-command", { detail: { action: "play" } }));

    return { calls, actions };
  });

  expect(result).toEqual({
    calls: [
      {
        plugin: "CupMediaSession",
        method: "setMetadata",
        options: { title: "A title", artworkUrl: "https://example.com/cover?token=fixture" },
      },
      { plugin: "CupMediaSession", method: "addListener", options: { eventName: "command" } },
      {
        plugin: "CupMediaSession",
        method: "setPositionState",
        options: { durationMilliseconds: 15_000, positionMilliseconds: 5_500, playbackRate: 1.5 },
      },
      {
        plugin: "CupMediaSession",
        method: "setPlaybackState",
        options: { playbackState: "playing", isWaiting: true, hasEnded: false },
      },
      {
        plugin: "CupMediaSession",
        method: "setPlaybackState",
        options: { playbackState: "paused", isWaiting: false, hasEnded: true },
      },
      { plugin: "CupMediaSession", method: "setMetadata", options: { title: "Without a cover" } },
      { plugin: "CupMediaSession", method: "clear", options: undefined },
    ],
    actions: [
      "play",
      "pause",
      "stop",
      "seekTo:7250",
      "seekBackward:15000",
      "seekForward:15000",
      "play again",
    ],
  });
});
