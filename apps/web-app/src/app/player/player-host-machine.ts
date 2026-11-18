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

/** A track that was loaded and no longer exists, such as one deleted on another device. */
export type UnavailableTrack = { conversionId: string; message: string };

/**
 * How old a track URL may be before Play renews it. The signed URL stays valid for at least 24
 * hours after the server handed it out, by the server clock; half of that tolerates a skewed client
 * clock.
 */
const TRACK_URL_RENEWAL_AGE_MILLISECONDS = 12 * 60 * 60 * 1_000;
const RENEWAL_ERROR_MESSAGE = "The audio could not be loaded again. Press Play to try again.";
const UNAVAILABLE_TRACK_MESSAGE = "This track is no longer available.";

export type PlayerHostMachineInput = {
  services: PlayerHostServices;
  /** The system's media controls act like Cup's own controls, which the facade owns. */
  mediaSessionHandlers: MediaSessionActionHandlers;
};

/** What the listener asked of the shown audiobook: load it, and optionally seek and play. */
type ShownStart = { seek: ShownSeek | null; play: boolean };

/** Where the listener moves the shown audiobook from the player sheet or its segments. */
type ShownSeek =
  | { kind: "unit"; unitIndex: number }
  | { kind: "position"; positionMilliseconds: number }
  | { kind: "skip"; deltaMilliseconds: number };

/**
 * What `loading` still owes once the player is built: the listener's start, and Pause or an unload
 * that arrived while the player was being built.
 */
type PendingLoad = ShownStart & { conversionId: string; unload: PositionOnClose | null };

type PlayerHostContext = PlayerHostMachineInput & {
  loaded: LoadedAudiobook | null;
  shown: ShownConversion | null;
  /** The last loaded track found gone, until another audiobook is loaded. */
  unavailable: UnavailableTrack | null;
  /** When the client received the shown audiobook, whose track URL a load uses. */
  shownAudiobookReceivedAt: number;
  /** When the client received the loaded audiobook's signed URLs. */
  urlsReceivedAt: number;
  /** Set while `loading`. */
  pendingLoad: PendingLoad | null;
  /** The last load failed; the facade rethrows it to the tap that asked for the load. */
  loadFailure: { error: unknown } | null;
  /** What played when the page started, while the host decides whether to take it over. */
  runningPlayer: RunningPlayer | null;
  /** Taking over what played failed; the facade rejects `adoptRunningPlayer` with it. */
  adoptionFailure: { error: unknown } | null;
};

export type PlayerHostMachineSnapshot = SnapshotFrom<typeof playerHostMachine>;

/** What `loading` waits for: the effect that builds a player reports its outcome as one of these. */
type LoadOutcome =
  | {
      type: "PLAYER_BUILT";
      loaded: LoadedAudiobook;
      /** A listener's load dates the track URL; a takeover does not know its age. */
      origin: { kind: "load"; urlsReceivedAt: number } | { kind: "takeover" };
    }
  | { type: "LOAD_REFUSED"; error: unknown }
  | { type: "LOAD_FAILED"; error: unknown }
  | { type: "ADOPTION_FAILED"; error: unknown };

/** Queues an effect on the transition's `enq`. */
type EnqueueEffect = (effect: () => void) => void;

/** Sends an event to the machine itself, from an effect. */
type SelfRef = { send: (event: LoadOutcome | { type: "PLAYER_CLOSED" }) => void };

/** The adoption is over, whatever became of what played. */
const ADOPTION_DONE = {
  target: "#playerHost.adoption.done",
  context: { runningPlayer: null },
} as const;

/** Tells the system's media controls about the loaded audiobook while it is loaded. */
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
      // The docs write payload-less events as `types<{}>()`, which the lint forbids as an empty type.
      SHOW: types<{
        conversionId: string;
        audiobook: PreparedAudiobook | undefined;
        receivedAt: number;
      }>(),
      HIDE: types<{ conversionId: string }>(),
      /** The account's restore finished or the signed-in user changed; the host reads it again. */
      ACCOUNT_CHANGED: z.object({}),
      PLAY: z.object({}),
      PAUSE: z.object({}),
      /** Loads the shown audiobook, paused, replacing the loaded one. */
      LOAD_SHOWN: z.object({}),
      /** Plays the shown audiobook, from the start of a unit if given, loading it first. */
      PLAY_SHOWN: types<{ unitIndex: number | undefined }>(),
      /** Seeks the shown audiobook, loading it paused first. */
      SEEK_SHOWN: types<{ positionMilliseconds: number }>(),
      /** Skips by an amount in the shown audiobook, loading it paused first. */
      SKIP_SHOWN: types<{ deltaMilliseconds: number }>(),
      UNLOAD: types<{ position: PositionOnClose }>(),
      /** Unloads `conversionId`, which the listener is deleting, without saving its position. */
      RELEASE: types<{ conversionId: string }>(),
      /** Looks once for what plays when the page starts, to take it over. */
      FIND_RUNNING_PLAYER: z.object({}),
      FORGET_LOAD_FAILURE: z.object({}),
      /*
       * Sent by the machine's own effects, which build and close players: a transition only
       * computes, so an effect reports what it made as an event, within the same `send`.
       */
      PLAYER_BUILT: types<Omit<Extract<LoadOutcome, { type: "PLAYER_BUILT" }>, "type">>(),
      LOAD_REFUSED: types<{ error: unknown }>(),
      LOAD_FAILED: types<{ error: unknown }>(),
      ADOPTION_FAILED: types<{ error: unknown }>(),
      PLAYER_CLOSED: z.object({}),
    },
    internalEvents: {
      /** The adoption region found what played and its audiobook; `playback` takes it over. */
      RUNNING_PLAYER_FOUND: types<{ runningPlayer: RunningPlayer; audiobook: PlayableAudiobook }>(),
      /** The listener loaded an audiobook, which ends any adoption in progress. */
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

/**
 * Which audiobook the app's player holds, and what the page that is shown can start.
 *
 * Two regions run side by side:
 *
 * - `playback`: `empty` → `loading` → `loaded` when the listener starts the shown audiobook or the
 *   host takes over what played when the page started. `loading` waits for the effect that builds
 *   the player, which reports back within the same `send`, so Play still runs in the tap's gesture;
 *   what the listener asks for meanwhile is kept in `pendingLoad` and applied once it is built.
 *   `loaded` is `ready`, or `renewingTrackUrl` while Play waits for a newly signed track URL;
 *   Pause, unloading or loading another audiobook leaves that state, which stops the request and
 *   discards its result. Unloading closes the player and clears the system's media controls.
 * - `adoption`: runs once, from `FIND_RUNNING_PLAYER`: find what plays → wait until the account is
 *   known and check that it is the listener's → fetch its audiobook → hand it to `playback` and
 *   wait for it to be built. Loading an audiobook in the meantime ends it: the load replaced what
 *   played.
 *
 * The shown conversion and its resume position are context, updated in place on `SHOW`, `HIDE` and
 * account changes. Playback itself (playing, buffering, the position) stays with the `Player`: the
 * element or the native player is that state (ADR 0011).
 */
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
      // The listening position belongs to the user the audiobook was loaded for.
      const account = context.services.getAccount();
      if (
        account.status === "known" &&
        context.loaded &&
        context.loaded.subject !== account.subject
      ) {
        enq.raise({ type: "UNLOAD", position: "save" });
      }
      // Which listening position applies depends on the account.
      return refreshResumePosition(context);
    },
    // Playback moved the listening position, which a listener without an account keeps only on
    // the device, where the shown audiobook does not see it change.
    PLAYER_CLOSED: ({ context }) => refreshResumePosition(context),
    FORGET_LOAD_FAILURE: { context: { loadFailure: null } },
  },
  states: {
    playback: {
      initial: "empty",
      // `empty` and `loaded` start the shown audiobook alike; `loading` handles these itself.
      on: {
        LOAD_SHOWN: ({ context, self }, enq) =>
          startShown(context, { seek: null, play: false }, self, enq),
        PLAY_SHOWN: ({ context, event, self }, enq) =>
          startShown(context, { seek: unitSeek(event.unitIndex), play: true }, self, enq),
        SEEK_SHOWN: ({ context, event, self }, enq) =>
          startShown(context, { seek: { kind: "position", ...event }, play: false }, self, enq),
        SKIP_SHOWN: ({ context, event, self }, enq) =>
          startShown(context, { seek: { kind: "skip", ...event }, play: false }, self, enq),
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
                  pendingLoad: { conversionId, seek: null, play: false, unload: null },
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
              const { seek } = pendingLoad;
              if (seek) {
                enq(() => applySeek(player, seek));
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
            // A port refused the listening session before anything that plays was touched.
            LOAD_REFUSED: ({ context, event }) => ({
              target: context.loaded ? "loaded" : "empty",
              context: { pendingLoad: null, loadFailure: { error: event.error } },
            }),
            // The previous player was closed, and the new one could not be built.
            LOAD_FAILED: ({ event }) => ({
              target: "empty",
              context: { loaded: null, pendingLoad: null, loadFailure: { error: event.error } },
            }),
            ADOPTION_FAILED: { target: "empty", context: { pendingLoad: null } },
            /*
             * These arrive here only when they were sent while the machine was handling another
             * event, so the player that is being built has not reported back yet. A second start
             * of another audiobook is dropped; the listener can tap again.
             */
            LOAD_SHOWN: ({ context }) => withPendingLoad(context, { seek: null, play: false }),
            PLAY_SHOWN: ({ context, event }) =>
              withPendingLoad(context, { seek: unitSeek(event.unitIndex), play: true }),
            SEEK_SHOWN: ({ context, event }) =>
              withPendingLoad(context, { seek: { kind: "position", ...event }, play: false }),
            SKIP_SHOWN: ({ context, event }) =>
              withPendingLoad(context, { seek: { kind: "skip", ...event }, play: false }),
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
            /**
             * Play requests the audiobook again for a newly signed track URL, then sets it at the
             * same position and plays. Play is ignored meanwhile.
             */
            renewingTrackUrl: {
              invoke: {
                src: "fetchAudiobook",
                input: ({ context }) => ({
                  services: context.services,
                  conversionId: requireLoaded(context).conversionId,
                }),
                onDone: ({ context, event, self }, enq) => {
                  const audiobook = event.output;
                  // The position of a track that no longer exists has nowhere to go.
                  if (audiobook === null) {
                    return unload(context, "discard", self, enq, markUnavailable(context));
                  }

                  const { player } = requireLoaded(context);
                  // Without a narration track the audiobook is no longer playable, e.g. after a
                  // retry.
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
                // The request layer reports the failure itself; the player shows that Play did
                // not start.
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
          // A load replaced what played, so there is nothing left to take over.
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
                onError: ({ event }) => ({
                  ...ADOPTION_DONE,
                  context: { runningPlayer: null, adoptionFailure: { error: event.error } },
                }),
              },
            },
            /** Who listens is unknown while the stored account is restored. */
            awaitingAccount: {
              always: ({ context }, enq) => {
                const account = context.services.getAccount();
                if (account.status !== "known") {
                  return undefined;
                }
                // The listener loaded an audiobook before the account was known.
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
                  // The listener loaded an audiobook while it was fetched.
                  if (isPlaybackBusy(context)) {
                    return ADOPTION_DONE;
                  }
                  // A deleted audiobook, or one that lost its narration track, cannot be taken
                  // over.
                  if (audiobook?.status !== "ready" || !isPlayableAudiobook(audiobook)) {
                    enq(() => discardRunningPlayer(runningPlayer));
                    return ADOPTION_DONE;
                  }
                  enq.raise({ type: "RUNNING_PLAYER_FOUND", runningPlayer, audiobook });
                  return { target: "handingOver" };
                },
                // The request layer reports the failure itself; the session plays on, and the
                // next load replaces it.
                onError: ADOPTION_DONE,
              },
            },
            /** `playback` builds the player for what played; adoption is done once it reports. */
            handingOver: {
              on: {
                PLAYER_BUILT: ADOPTION_DONE,
                ADOPTION_FAILED: ({ event }) => ({
                  ...ADOPTION_DONE,
                  context: { runningPlayer: null, adoptionFailure: { error: event.error } },
                }),
              },
            },
          },
        },
        done: {},
      },
    },
  },
});

/**
 * Starts the shown audiobook from `empty` or `loaded`. A loaded one is sought and played in place.
 * Another one is checked first: an audiobook whose listening session would be refused fails the tap
 * while the loaded audiobook plays on, also through a track URL renewal in progress.
 */
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
    // Nothing to load: the effects above act on the loaded player.
    return undefined;
  }

  const refusal = findSessionRefusal(shown.conversionId, shown.audiobook);
  if (refusal) {
    return { context: { loadFailure: { error: refusal } } };
  }

  enq(() => self.send(buildShownPlayer(context)));
  return {
    target: "#playerHost.playback.loading",
    context: { pendingLoad: { ...start, conversionId: shown.conversionId, unload: null } },
  };
}

/**
 * Merges a start of the audiobook being built into what `loading` owes. A start of another one is
 * dropped, and handled here so it does not reach `playback`, which would build a second player.
 */
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
        seek: mergeSeeks(pendingLoad.seek, start.seek),
      },
    },
  };
}

/** Skips add up; any other seek replaces the one before it. */
function mergeSeeks(earlier: ShownSeek | null, later: ShownSeek | null): ShownSeek | null {
  if (!later) {
    return earlier;
  }
  if (earlier?.kind === "skip" && later.kind === "skip") {
    return { kind: "skip", deltaMilliseconds: earlier.deltaMilliseconds + later.deltaMilliseconds };
  }
  return later;
}

function unitSeek(unitIndex: number | undefined): ShownSeek | null {
  return unitIndex === undefined ? null : { kind: "unit", unitIndex };
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

/** Whether `playback` holds or is building an audiobook. */
function isPlaybackBusy({ loaded, pendingLoad }: PlayerHostContext) {
  return loaded !== null || pendingLoad !== null;
}

/** A media error, or a track URL older than the renewal age, needs a newly signed URL. */
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

/** Reads the shown audiobook's resume position again; keeps the same object when unchanged. */
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

/** Keeps the page of a track that no longer exists from playing it. */
function markUnavailable(context: PlayerHostContext): Partial<PlayerHostContext> {
  const { conversionId } = requireLoaded(context);
  const { shown } = context;
  return {
    unavailable: { conversionId, message: UNAVAILABLE_TRACK_MESSAGE },
    shown: shown?.conversionId === conversionId ? { ...shown, canPlay: false } : shown,
  };
}

/**
 * Leaves `loaded` for `empty`. Leaving it stops reporting to the system's media controls; the
 * effect then closes the player, clears the controls, and has the resume position read again.
 */
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

/**
 * Builds the shown audiobook's session and player, as an effect. The listening session is created
 * first, since it touches nothing that plays: a port that refuses it leaves the loaded audiobook
 * playing. The previous player is closed next, because it must stop listening to the element before
 * the new player sets its source. A player that cannot be built after that leaves nothing loaded;
 * on Android the previous native session then stays open until the next load or a reload.
 */
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

/** The session's URLs came from an earlier page, so the first Play renews them. */
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

/** Stops the player for good and clears the system's media controls. */
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

/**
 * Runs an effect on a port and reports its failure instead of throwing: an effect that throws stops
 * the machine for the rest of the page, so the host would ignore every later control. Browsers
 * throw from some Media Session calls, such as an action they do not support.
 */
function runEffect(description: string, effect: () => void) {
  try {
    effect();
  } catch (error) {
    const message = `The player could not ${description}.`;
    console.error(message, error);
    reportFailure(message)(error);
  }
}

/** Signed-in listeners keep their position on the server; others on the device. */
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

/**
 * Where loading the audiobook resumes: the listener's listening position within the track, or the
 * start while it cannot play or the account is being restored.
 */
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

/**
 * The duration is the narration track's listed one, the timeline the reader and the position bar
 * use, not the player's.
 */
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
    // The player returns to the start at the end, so only the change tells it ended.
    hasEnded: change?.hasEnded ?? false,
  });
  services.mediaSession.setPositionState({
    durationMilliseconds,
    positionMilliseconds: Math.min(positionMilliseconds, durationMilliseconds),
    playbackRate,
  });
}

/** `loaded` and its states exist only while an audiobook is loaded. */
function requireLoaded({ loaded }: Pick<PlayerHostContext, "loaded">): LoadedAudiobook {
  if (!loaded) {
    throw new Error("Expected a loaded audiobook.");
  }
  return loaded;
}

/** `loading` exists only while a player is being built. */
function requirePendingLoad({ pendingLoad }: PlayerHostContext): PendingLoad {
  if (!pendingLoad) {
    throw new Error("Expected a player being built.");
  }
  return pendingLoad;
}

/** The adoption states after `findingRunningPlayer` exist only once a running player was found. */
function requireRunningPlayer({ runningPlayer }: PlayerHostContext): RunningPlayer {
  if (!runningPlayer) {
    throw new Error("Expected a running player to take over.");
  }
  return runningPlayer;
}
