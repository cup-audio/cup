import {
  createAsyncLogic,
  createCallbackLogic,
  setup,
  types,
  type EventObject,
  type SnapshotFrom,
} from "xstate";
import { z } from "zod";

import type { Audiobook } from "@cup/listener-api.routes";

import { clampToTimeline } from "#src/app/player/audiobook-timeline.ts";
import {
  findSessionRefusal,
  isPlayableAudiobook,
  toTrackPositionMilliseconds,
  type PlayableAudiobook,
  type PlaybackSession,
  type PlaybackSessionRequest,
  type PreparedAudiobook,
} from "#src/app/player/playback-session.ts";
import type {
  LoadedAudiobook,
  PlayerHostServices,
  ShownConversion,
} from "#src/app/player/player-host.ts";
import type {
  PlaybackChange,
  Player,
  PlayerEnding,
  PositionOnClose,
  RunningPlayer,
} from "#src/app/player/player.ts";
import type { MediaSessionActionHandlers } from "#src/platform/media-session.ts";
import { reportFailure } from "#src/report-failure.ts";

export type UnavailableTrack = { conversionId: string; message: string };

export type PlayerHostMachineInput = {
  services: PlayerHostServices;
  mediaSessionHandlers: MediaSessionActionHandlers;
};

export type PlayerHostMachineSnapshot = SnapshotFrom<typeof playerHostMachine>;

const TRACK_URL_RENEWAL_AGE_MILLISECONDS = 12 * 60 * 60 * 1_000;
const RENEWAL_ERROR_MESSAGE = "The audio could not be loaded again. Press Play to try again.";
const UNAVAILABLE_TRACK_MESSAGE = "This track is no longer available.";

type ShownStart = { seek: ShownSeek | null; play: boolean };

type ShownSeek =
  | { kind: "unit"; unitIndex: number }
  | { kind: "position"; positionMilliseconds: number }
  | { kind: "skip"; deltaMilliseconds: number };

type ShownStartEvent =
  | { type: "LOAD_SHOWN" }
  | { type: "PLAY_SHOWN"; unitIndex: number | undefined }
  | { type: "SEEK_SHOWN"; positionMilliseconds: number }
  | { type: "SKIP_SHOWN"; deltaMilliseconds: number };

type PendingLoad = {
  conversionId: string;
  seeks: ShownSeek[];
  play: boolean;
  unload: PositionOnClose | null;
};

type PlayerHostContext = PlayerHostMachineInput & {
  loaded: LoadedAudiobook | null;
  shown: ShownConversion | null;
  unavailable: UnavailableTrack | null;
  shownAudiobookReceivedAt: number;
  urlsReceivedAt: number;
  pendingLoad: PendingLoad | null;
  loadFailure: { error: unknown } | null;
  runningPlayer: RunningPlayer | null;
  adoptionFailure: { error: unknown } | null;
};

type LoadOutcome =
  | {
      type: "PLAYER_BUILT";
      loaded: LoadedAudiobook;
      origin: { kind: "load"; urlsReceivedAt: number } | { kind: "takeover" };
    }
  | { type: "LOAD_REFUSED"; error: unknown }
  | { type: "LOAD_FAILED"; error: unknown }
  | { type: "ADOPTION_FAILED"; error: unknown };

type EnqueueEffect = (effect: () => void) => void;

type SelfRef = { send: (event: LoadOutcome | { type: "PLAYER_CLOSED" }) => void };

const ADOPTION_DONE = {
  target: "#playerHost.adoption.done",
  context: { runningPlayer: null },
} as const;

const showInMediaSessionLogic = createCallbackLogic<
  EventObject,
  { services: PlayerHostServices; loaded: LoadedAudiobook; handlers: MediaSessionActionHandlers }
>(({ input: { services, loaded, handlers } }) => {
  const { mediaSession } = services;
  const { audiobook, player } = loaded;
  runEffect("show the audiobook in the system's media controls", () => {
    mediaSession.setMetadata({ title: audiobook.title, artworkUrl: audiobook.coverImage?.url });
    mediaSession.setActionHandlers(handlers);
  });

  const report = (change?: PlaybackChange) =>
    runEffect("report playback to the system's media controls", () =>
      reportToMediaSession(services, loaded, change),
    );
  const unsubscribe = player.subscribePlaybackChanges(report);
  report();
  return unsubscribe;
});

const playerHostSetup = setup({
  schemas: {
    context: types<PlayerHostContext>(),
    input: types<PlayerHostMachineInput>(),
    events: {
      SHOW: types<{
        conversionId: string;
        audiobook: PreparedAudiobook | undefined;
        receivedAt: number;
      }>(),
      HIDE: types<{ conversionId: string }>(),
      ACCOUNT_CHANGED: z.object({}),
      PLAY: z.object({}),
      PAUSE: z.object({}),
      LOAD_SHOWN: z.object({}),
      PLAY_SHOWN: types<{ unitIndex: number | undefined }>(),
      SEEK_SHOWN: types<{ positionMilliseconds: number }>(),
      SKIP_SHOWN: types<{ deltaMilliseconds: number }>(),
      UNLOAD: types<{ position: PositionOnClose }>(),
      RELEASE: types<{ conversionId: string }>(),
      FIND_RUNNING_PLAYER: z.object({}),
      FORGET_LOAD_FAILURE: z.object({}),
      PLAYER_BUILT: types<Omit<Extract<LoadOutcome, { type: "PLAYER_BUILT" }>, "type">>(),
      LOAD_REFUSED: types<{ error: unknown }>(),
      LOAD_FAILED: types<{ error: unknown }>(),
      ADOPTION_FAILED: types<{ error: unknown }>(),
      PLAYER_CLOSED: z.object({}),
    },
    internalEvents: {
      RUNNING_PLAYER_FOUND: types<{ runningPlayer: RunningPlayer; audiobook: PlayableAudiobook }>(),
      PLAYER_LOADED: z.object({}),
    },
  },
  actors: {
    findRunningPlayer: createAsyncLogic<RunningPlayer | null, { services: PlayerHostServices }>({
      run: ({ input }) => input.services.findRunningPlayer(),
    }),
    fetchAudiobook: createAsyncLogic<
      Audiobook | null,
      { services: PlayerHostServices; conversionId: string }
    >({
      run: ({ input }) => input.services.fetchAudiobook(input.conversionId),
    }),
    showInMediaSession: showInMediaSessionLogic,
  },
});

export const playerHostMachine = playerHostSetup.createMachine({
  id: "playerHost",
  type: "parallel",
  context: ({ input }) => ({
    ...input,
    loaded: null,
    shown: null,
    unavailable: null,
    shownAudiobookReceivedAt: 0,
    urlsReceivedAt: 0,
    pendingLoad: null,
    loadFailure: null,
    runningPlayer: null,
    adoptionFailure: null,
  }),
  on: {
    SHOW: ({ context, event }) => ({ context: showConversion(context, event) }),
    HIDE: ({ context, event }) => {
      if (context.shown?.conversionId !== event.conversionId) {
        return undefined;
      }
      return { context: { shown: null } };
    },
    ACCOUNT_CHANGED: ({ context }, enq) => {
      const account = context.services.getAccount();
      if (
        account.status === "known" &&
        context.loaded &&
        context.loaded.subject !== account.subject
      ) {
        enq.raise({ type: "UNLOAD", position: "save" });
      }
      return refreshResumePosition(context);
    },
    PLAYER_CLOSED: ({ context }) => refreshResumePosition(context),
    FORGET_LOAD_FAILURE: { context: { loadFailure: null } },
  },
  states: {
    playback: {
      initial: "empty",
      on: {
        LOAD_SHOWN: ({ context, event, self }, enq) =>
          startShown(context, toShownStart(event), self, enq),
        PLAY_SHOWN: ({ context, event, self }, enq) =>
          startShown(context, toShownStart(event), self, enq),
        SEEK_SHOWN: ({ context, event, self }, enq) =>
          startShown(context, toShownStart(event), self, enq),
        SKIP_SHOWN: ({ context, event, self }, enq) =>
          startShown(context, toShownStart(event), self, enq),
      },
      states: {
        empty: {
          on: {
            RUNNING_PLAYER_FOUND: ({ context, event, self }, enq) => {
              const { conversionId } = event.runningPlayer;
              enq(() => self.send(adoptRunningPlayer(context.services, event)));
              return {
                target: "loading",
                context: {
                  pendingLoad: { conversionId, seeks: [], play: false, unload: null },
                },
              };
            },
          },
        },
        loading: {
          on: {
            PLAYER_BUILT: ({ context, event }, enq) => {
              const pendingLoad = requirePendingLoad(context);
              const { player } = event.loaded;
              const { seeks } = pendingLoad;
              if (seeks.length > 0) {
                enq(() => {
                  for (const seek of seeks) {
                    applySeek(player, seek);
                  }
                });
              }
              if (event.origin.kind === "load") {
                enq.raise({ type: "PLAYER_LOADED" });
              }
              if (pendingLoad.play) {
                enq.raise({ type: "PLAY" });
              }
              if (pendingLoad.unload) {
                enq.raise({ type: "UNLOAD", position: pendingLoad.unload });
              }
              return {
                target: "loaded",
                context: {
                  loaded: event.loaded,
                  unavailable: null,
                  pendingLoad: null,
                  loadFailure: null,
                  urlsReceivedAt:
                    event.origin.kind === "load"
                      ? event.origin.urlsReceivedAt
                      : context.urlsReceivedAt,
                },
              };
            },
            LOAD_REFUSED: ({ context, event }) => ({
              target: context.loaded ? "loaded" : "empty",
              context: { pendingLoad: null, loadFailure: { error: event.error } },
            }),
            LOAD_FAILED: ({ event }) => ({
              target: "empty",
              context: { loaded: null, pendingLoad: null, loadFailure: { error: event.error } },
            }),
            ADOPTION_FAILED: { target: "empty", context: { pendingLoad: null } },
            LOAD_SHOWN: ({ context, event }) => withPendingLoad(context, toShownStart(event)),
            PLAY_SHOWN: ({ context, event }) => withPendingLoad(context, toShownStart(event)),
            SEEK_SHOWN: ({ context, event }) => withPendingLoad(context, toShownStart(event)),
            SKIP_SHOWN: ({ context, event }) => withPendingLoad(context, toShownStart(event)),
            PLAY: ({ context }) => ({
              context: { pendingLoad: { ...requirePendingLoad(context), play: true } },
            }),
            PAUSE: ({ context }) => ({
              context: { pendingLoad: { ...requirePendingLoad(context), play: false } },
            }),
            UNLOAD: ({ context, event }) => ({
              context: { pendingLoad: { ...requirePendingLoad(context), unload: event.position } },
            }),
            RELEASE: ({ context, event }) => {
              const pendingLoad = requirePendingLoad(context);
              if (pendingLoad.conversionId !== event.conversionId) {
                return undefined;
              }
              return { context: { pendingLoad: { ...pendingLoad, unload: "discard" } } };
            },
          },
        },
        loaded: {
          initial: "ready",
          invoke: {
            src: "showInMediaSession",
            input: ({ context }) => ({
              services: context.services,
              loaded: requireLoaded(context),
              handlers: context.mediaSessionHandlers,
            }),
          },
          on: {
            PAUSE: ({ context }, enq) => {
              const { player } = requireLoaded(context);
              enq(() => runEffect("pause", () => player.pause()));
              return { target: ".ready" };
            },
            UNLOAD: ({ context, event, self }, enq) => unload(context, event.position, self, enq),
            RELEASE: ({ context, event, self }, enq) => {
              if (requireLoaded(context).conversionId !== event.conversionId) {
                return undefined;
              }
              return unload(context, "discard", self, enq);
            },
          },
          states: {
            ready: {
              on: {
                PLAY: ({ context }, enq) => {
                  if (needsNewTrackUrl(context)) {
                    return { target: "renewingTrackUrl" };
                  }
                  const { player } = requireLoaded(context);
                  enq(() => runEffect("play", () => player.play()));
                  return undefined;
                },
              },
            },
            renewingTrackUrl: {
              invoke: {
                src: "fetchAudiobook",
                input: ({ context }) => ({
                  services: context.services,
                  conversionId: requireLoaded(context).conversionId,
                }),
                onDone: ({ context, event, self }, enq) => {
                  const audiobook = event.output;
                  if (audiobook === null) {
                    return unload(context, "discard", self, enq, markUnavailable(context));
                  }

                  const { player } = requireLoaded(context);
                  if (audiobook.status !== "ready" || !audiobook.narrationTrack) {
                    enq(() => showRenewalError(player));
                    return { target: "ready" };
                  }

                  const { narrationTrack } = audiobook;
                  const urlsReceivedAt = context.services.now();
                  enq(() =>
                    runEffect("play the renewed track", () => {
                      player.replaceUrls(narrationTrack, urlsReceivedAt);
                      player.play();
                    }),
                  );
                  return { target: "ready", context: { urlsReceivedAt } };
                },
                onError: ({ context }, enq) => {
                  const { player } = requireLoaded(context);
                  enq(() => showRenewalError(player));
                  return { target: "ready" };
                },
              },
            },
          },
        },
      },
    },
    adoption: {
      initial: "notStarted",
      states: {
        notStarted: {
          on: { FIND_RUNNING_PLAYER: { target: "adopting" } },
        },
        adopting: {
          initial: "findingRunningPlayer",
          on: { PLAYER_LOADED: ADOPTION_DONE },
          states: {
            findingRunningPlayer: {
              invoke: {
                src: "findRunningPlayer",
                input: ({ context }) => ({ services: context.services }),
                onDone: ({ event }) => {
                  if (event.output === null) {
                    return ADOPTION_DONE;
                  }
                  return { target: "awaitingAccount", context: { runningPlayer: event.output } };
                },
                onError: ({ event }) => adoptionFailed(event.error),
              },
            },
            awaitingAccount: {
              always: ({ context }, enq) => {
                const account = context.services.getAccount();
                if (account.status !== "known") {
                  return undefined;
                }
                if (isPlaybackBusy(context)) {
                  return ADOPTION_DONE;
                }
                const runningPlayer = requireRunningPlayer(context);
                if (runningPlayer.subject !== account.subject) {
                  enq(() => discardRunningPlayer(runningPlayer));
                  return ADOPTION_DONE;
                }
                return { target: "fetchingAudiobook" };
              },
            },
            fetchingAudiobook: {
              invoke: {
                src: "fetchAudiobook",
                input: ({ context }) => ({
                  services: context.services,
                  conversionId: requireRunningPlayer(context).conversionId,
                }),
                onDone: ({ context, event }, enq) => {
                  const runningPlayer = requireRunningPlayer(context);
                  const audiobook = event.output;
                  if (isPlaybackBusy(context)) {
                    return ADOPTION_DONE;
                  }
                  if (audiobook?.status !== "ready" || !isPlayableAudiobook(audiobook)) {
                    enq(() => discardRunningPlayer(runningPlayer));
                    return ADOPTION_DONE;
                  }
                  enq.raise({ type: "RUNNING_PLAYER_FOUND", runningPlayer, audiobook });
                  return { target: "handingOver" };
                },
                onError: ADOPTION_DONE,
              },
            },
            handingOver: {
              on: {
                PLAYER_BUILT: ADOPTION_DONE,
                ADOPTION_FAILED: ({ event }) => adoptionFailed(event.error),
              },
            },
          },
        },
        done: {},
      },
    },
  },
});

function startShown(
  context: PlayerHostContext,
  start: ShownStart,
  self: SelfRef,
  enq: EnqueueEffect & { raise: (event: { type: "PLAY" }) => void },
) {
  const { shown, loaded } = context;
  if (!shown?.canPlay || !shown.audiobook || !isPlayableAudiobook(shown.audiobook)) {
    return undefined;
  }

  if (shown.conversionId === loaded?.conversionId) {
    const { player } = loaded;
    const { seek } = start;
    if (seek) {
      enq(() => applySeek(player, seek));
    }
    if (start.play) {
      enq.raise({ type: "PLAY" });
    }
    return undefined;
  }

  const refusal = findSessionRefusal(shown.conversionId, shown.audiobook);
  if (refusal) {
    return { context: { loadFailure: { error: refusal } } };
  }

  enq(() => self.send(buildShownPlayer(context)));
  return {
    target: "#playerHost.playback.loading",
    context: {
      pendingLoad: {
        conversionId: shown.conversionId,
        seeks: start.seek ? [start.seek] : [],
        play: start.play,
        unload: null,
      },
    },
  };
}

function withPendingLoad(context: PlayerHostContext, start: ShownStart) {
  const pendingLoad = requirePendingLoad(context);
  if (context.shown?.conversionId !== pendingLoad.conversionId) {
    return { context: {} };
  }
  return {
    context: {
      pendingLoad: {
        ...pendingLoad,
        play: pendingLoad.play || start.play,
        seeks: start.seek ? [...pendingLoad.seeks, start.seek] : pendingLoad.seeks,
      },
    },
  };
}

function toShownStart(event: ShownStartEvent): ShownStart {
  if (event.type === "LOAD_SHOWN") {
    return { seek: null, play: false };
  }
  if (event.type === "PLAY_SHOWN") {
    const { unitIndex } = event;
    return { seek: unitIndex === undefined ? null : { kind: "unit", unitIndex }, play: true };
  }
  if (event.type === "SEEK_SHOWN") {
    const { positionMilliseconds } = event;
    return { seek: { kind: "position", positionMilliseconds }, play: false };
  }
  const { deltaMilliseconds } = event;
  return { seek: { kind: "skip", deltaMilliseconds }, play: false };
}

function adoptionFailed(error: unknown) {
  return {
    ...ADOPTION_DONE,
    context: { runningPlayer: null, adoptionFailure: { error } },
  };
}

function applySeek(player: Player, seek: ShownSeek) {
  runEffect("seek", () => {
    switch (seek.kind) {
      case "unit": {
        player.seekToUnit(seek.unitIndex);
        break;
      }
      case "position": {
        player.seekTo(seek.positionMilliseconds);
        break;
      }
      case "skip": {
        player.skipBy(seek.deltaMilliseconds);
        break;
      }
    }
  });
}

function isPlaybackBusy({ loaded, pendingLoad }: PlayerHostContext) {
  return loaded !== null || pendingLoad !== null;
}

function needsNewTrackUrl(context: PlayerHostContext) {
  const { player } = requireLoaded(context);
  return (
    player.getSnapshot().needsNewTrackUrl ||
    context.services.now() - context.urlsReceivedAt > TRACK_URL_RENEWAL_AGE_MILLISECONDS
  );
}

function showConversion(
  context: PlayerHostContext,
  event: { conversionId: string; audiobook: PreparedAudiobook | undefined; receivedAt: number },
): Partial<PlayerHostContext> {
  const previous = context.shown?.conversionId === event.conversionId ? context.shown : null;
  const audiobook = event.audiobook ?? previous?.audiobook ?? null;
  return {
    shownAudiobookReceivedAt:
      audiobook === previous?.audiobook ? context.shownAudiobookReceivedAt : event.receivedAt,
    shown: {
      conversionId: event.conversionId,
      audiobook,
      canPlay:
        audiobook !== null &&
        isPlayableAudiobook(audiobook) &&
        context.unavailable?.conversionId !== event.conversionId,
      resumePositionMilliseconds: readResumePositionMilliseconds(
        context.services,
        event.conversionId,
        audiobook,
      ),
    },
  };
}

function refreshResumePosition({ services, shown }: PlayerHostContext) {
  if (!shown) {
    return { context: { shown: null } };
  }

  const resumePositionMilliseconds = readResumePositionMilliseconds(
    services,
    shown.conversionId,
    shown.audiobook,
  );
  return {
    context: {
      shown:
        resumePositionMilliseconds === shown.resumePositionMilliseconds
          ? shown
          : { ...shown, resumePositionMilliseconds },
    },
  };
}

function markUnavailable(context: PlayerHostContext): Partial<PlayerHostContext> {
  const { conversionId } = requireLoaded(context);
  const { shown } = context;
  return {
    unavailable: { conversionId, message: UNAVAILABLE_TRACK_MESSAGE },
    shown: shown?.conversionId === conversionId ? { ...shown, canPlay: false } : shown,
  };
}

function unload(
  context: PlayerHostContext,
  position: PositionOnClose,
  self: SelfRef,
  enq: EnqueueEffect,
  contextChanges: Partial<PlayerHostContext> = {},
) {
  const loaded = requireLoaded(context);
  const { services } = context;
  enq(() => {
    closeLoadedPlayer(loaded, services, position, "unload");
    self.send({ type: "PLAYER_CLOSED" });
  });
  return {
    target: "#playerHost.playback.empty",
    context: { ...contextChanges, loaded: null },
  };
}

function buildShownPlayer(context: PlayerHostContext): LoadOutcome {
  const { shown, services, loaded } = context;
  if (!shown?.audiobook || !isPlayableAudiobook(shown.audiobook)) {
    throw new Error("Expected a playable shown audiobook to load.");
  }

  const account = services.getAccount();
  const subject = account.status === "known" ? account.subject : null;
  let session: PlaybackSession;
  try {
    session = services.createSession(
      sessionRequest(services, shown.conversionId, shown.audiobook, subject),
    );
  } catch (error) {
    return { type: "LOAD_REFUSED", error };
  }

  if (loaded) {
    closeLoadedPlayer(loaded, services, "save", "replace");
  }

  const urlsReceivedAt = context.shownAudiobookReceivedAt;
  try {
    const player = services.createPlayer(session, urlsReceivedAt);
    return {
      type: "PLAYER_BUILT",
      loaded: { conversionId: shown.conversionId, audiobook: shown.audiobook, subject, player },
      origin: { kind: "load", urlsReceivedAt },
    };
  } catch (error) {
    session.close();
    return { type: "LOAD_FAILED", error };
  }
}

function adoptRunningPlayer(
  services: PlayerHostServices,
  { runningPlayer, audiobook }: { runningPlayer: RunningPlayer; audiobook: PlayableAudiobook },
): LoadOutcome {
  const { conversionId, subject } = runningPlayer;
  let session: PlaybackSession | null = null;
  try {
    session = services.createSession(sessionRequest(services, conversionId, audiobook, subject));
    const player = runningPlayer.adopt(session);
    return {
      type: "PLAYER_BUILT",
      loaded: { conversionId, audiobook, subject, player },
      origin: { kind: "takeover" },
    };
  } catch (error) {
    session?.close();
    return { type: "ADOPTION_FAILED", error };
  }
}

function closeLoadedPlayer(
  loaded: LoadedAudiobook,
  services: PlayerHostServices,
  position: PositionOnClose,
  ending: PlayerEnding,
) {
  runEffect("close the player", () => loaded.player.close(position, ending));
  runEffect("clear the system's media controls", () => services.mediaSession.clear());
}

function showRenewalError(player: Player) {
  runEffect("show the renewal error", () => player.showError(RENEWAL_ERROR_MESSAGE));
}

function discardRunningPlayer(runningPlayer: RunningPlayer) {
  runEffect("end what played when the page started", () => runningPlayer.discard());
}

function runEffect(description: string, effect: () => void) {
  try {
    effect();
  } catch (error) {
    const message = `The player could not ${description}.`;
    console.error(message, error);
    reportFailure(message)(error);
  }
}

function sessionRequest(
  services: PlayerHostServices,
  conversionId: string,
  audiobook: PlayableAudiobook,
  subject: string | null,
): PlaybackSessionRequest {
  return {
    conversionId,
    audiobook,
    position:
      subject === null ? services.getLocalPosition(conversionId) : audiobook.playbackPosition,
    subject,
  };
}

function readResumePositionMilliseconds(
  services: PlayerHostServices,
  conversionId: string,
  audiobook: PreparedAudiobook | null,
): number {
  const account = services.getAccount();
  if (!audiobook || !isPlayableAudiobook(audiobook) || account.status === "restoring") {
    return 0;
  }

  return clampToTimeline(
    audiobook.narrationTrack,
    toTrackPositionMilliseconds(
      audiobook,
      sessionRequest(services, conversionId, audiobook, account.subject).position,
    ),
  );
}

function reportToMediaSession(
  services: PlayerHostServices,
  loaded: LoadedAudiobook,
  change: PlaybackChange | undefined,
) {
  const { positionMilliseconds, isPlaying, isBuffering, playbackRate } =
    loaded.player.getSnapshot();
  const { durationMilliseconds } = loaded.audiobook.narrationTrack;
  services.mediaSession.setPlaybackState({
    playbackState: isPlaying ? "playing" : "paused",
    isWaiting: isBuffering,
    hasEnded: change?.hasEnded ?? false,
  });
  services.mediaSession.setPositionState({
    durationMilliseconds,
    positionMilliseconds: Math.min(positionMilliseconds, durationMilliseconds),
    playbackRate,
  });
}

function requireLoaded({ loaded }: Pick<PlayerHostContext, "loaded">): LoadedAudiobook {
  if (!loaded) {
    throw new Error("Expected a loaded audiobook.");
  }
  return loaded;
}

function requirePendingLoad({ pendingLoad }: PlayerHostContext): PendingLoad {
  if (!pendingLoad) {
    throw new Error("Expected a player being built.");
  }
  return pendingLoad;
}

function requireRunningPlayer({ runningPlayer }: PlayerHostContext): RunningPlayer {
  if (!runningPlayer) {
    throw new Error("Expected a running player to take over.");
  }
  return runningPlayer;
}
