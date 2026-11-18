import { createAsyncLogic, createCallbackLogic, setup, types, type SnapshotFrom } from "xstate";
import { z } from "zod";

import type { PlaybackPosition } from "@cup/listener-api.routes";

import type { PlaybackSessionServices } from "#src/app/player/playback-session.ts";
import { describeError } from "#src/errors.ts";
import { reportFailure } from "#src/report-failure.ts";

export type PositionSavesMachineInput = {
  services: PlaybackSessionServices;
  subject: string | null;
};

export type PositionSavesMachineSnapshot = SnapshotFrom<typeof positionSavesMachine>;

/** How long after a failed save its position is saved again, unless a newer save comes first. */
export const SAVE_RETRY_DELAY_MILLISECONDS = 15_000;
/** Shown once a failed save's retry failed too; the session keeps trying. */
export const SAVE_RETRY_FAILURE_MESSAGE =
  "Your listening position could not be saved yet. Cup keeps trying.";
const SAVE_FAILURE_TITLE = "Your listening position could not be saved.";

/** A save the listener's playback asked for, or the retry of one that failed. */
type SaveAttempt = "new" | "retry";
type QueuedSave = {
  position: PlaybackPosition;
  attempt: SaveAttempt;
  /** Resolves the promise of the `save` call once this save was written or failed. */
  resolveSave: () => void;
};

type PositionSavesContext = PositionSavesMachineInput & {
  /** Saves in the order they were asked for; the first one is being written. */
  queue: QueuedSave[];
  lastSavedAt: number;
  /** When the saves started failing for a reason that can pass; `null` after a successful one. */
  failingSince: number | null;
  /** The failure to show the listener, in plain words. */
  saveFailure: string | null;
  /** The position the armed retry saves. */
  retryPosition: PlaybackPosition | null;
};

const positionSavesSetup = setup({
  schemas: {
    context: types<PositionSavesContext>(),
    input: types<PositionSavesMachineInput>(),
    events: {
      SAVE: types<{ position: PlaybackPosition; resolveSave: () => void }>(),
      /** Stops retrying a failed save, which the session then no longer reports. */
      CLOSE: z.object({}),
      /** Sent by `retryTrigger`: the retry delay passed, or the connection may be back. */
      RETRY_DUE: z.object({}),
    },
    internalEvents: {
      /** The latest save failed for a reason that can pass. */
      ARM_RETRY: types<{ position: PlaybackPosition }>(),
    },
  },
  actors: {
    writePosition: createAsyncLogic<
      void,
      { services: PlaybackSessionServices; position: PlaybackPosition; subject: string | null }
    >({
      run: ({ input }) => input.services.savePosition(input.position, input.subject),
    }),
    /** Sends `RETRY_DUE` when the retry delay passed or the connection may be back. */
    retryTrigger: createCallbackLogic<{ type: "RETRY_DUE" }, { services: PlaybackSessionServices }>(
      ({ input: { services }, sendBack }) => {
        const retry = () => sendBack({ type: "RETRY_DUE" });
        // A throw here would stop the machine, and with it every save still queued; the next save
        // arms a retry again.
        try {
          const cancelTimer = services.setRetryTimer(retry, SAVE_RETRY_DELAY_MILLISECONDS);
          const stopReconnect = services.onReconnect(retry);
          return () => {
            cancelTimer();
            stopReconnect();
          };
        } catch (error) {
          reportFailure("The listening position's retry could not be armed.")(error);
          return undefined;
        }
      },
    ),
  },
});

/**
 * The save cadence and order of one listening session.
 *
 * Three regions run side by side:
 *
 * - `writer`: `idle` ⇄ `writing`. Saves are written one at a time, in the order they were asked for.
 *   A failed save whose position a newer queued save replaces counts for nothing.
 * - `retry`: `disarmed` ⇄ `armed`. The latest save failing for a reason that can pass, such as a lost
 *   connection, arms a retry of its position, after the retry delay or on a reconnect. Any newer
 *   save disarms it, since it carries a later position.
 * - `lifecycle`: `open` → `closed`. Saves asked for before closing are still written, such as the
 *   position saved when the player closes, but nothing is retried or reported any more.
 */
export const positionSavesMachine = positionSavesSetup.createMachine({
  id: "positionSaves",
  type: "parallel",
  context: ({ input }) => ({
    ...input,
    queue: [],
    lastSavedAt: Number.NEGATIVE_INFINITY,
    failingSince: null,
    saveFailure: null,
    retryPosition: null,
  }),
  states: {
    writer: {
      initial: "idle",
      on: {
        SAVE: ({ context, event }) => ({
          context: {
            queue: [
              ...context.queue,
              { position: event.position, attempt: "new", resolveSave: event.resolveSave },
            ],
            lastSavedAt: context.services.now(),
          },
        }),
      },
      states: {
        idle: {
          always: ({ context, self }, enq) => {
            const [next, ...rest] = context.queue;
            if (!next) {
              return undefined;
            }
            // A retry queued before the session closed, such as for a track being deleted, has no
            // use.
            if (next.attempt === "retry" && isClosed(self)) {
              enq(next.resolveSave);
              return { context: { queue: rest } };
            }
            return { target: "writing" };
          },
        },
        writing: {
          invoke: {
            src: "writePosition",
            input: ({ context }) => ({
              services: context.services,
              position: requireNextSave(context).position,
              subject: context.subject,
            }),
            onDone: ({ context, self }, enq) => {
              const written = requireNextSave(context);
              const rest = context.queue.slice(1);
              enq(written.resolveSave);
              return {
                target: "idle",
                context: {
                  queue: rest,
                  failingSince: null,
                  // A closed session reports nothing more.
                  ...(isClosed(self) ? {} : { saveFailure: null }),
                },
              };
            },
            onError: ({ context, event, self }, enq) => {
              const failed = requireNextSave(context);
              const newer = context.queue.slice(1);
              enq(failed.resolveSave);
              const backToIdle = { target: "idle", context: { queue: newer } } as const;
              const description = describeError(event.error, SAVE_FAILURE_TITLE);
              if (!description.isRetryable) {
                // A lasting refusal, such as a signed-out listener; saving again would be refused
                // too.
                return withFailure(backToIdle, self, description.detail ?? description.title);
              }

              // A newer save is queued already and carries a later position; its outcome counts.
              if (newer.length > 0) {
                return backToIdle;
              }

              const now = context.services.now();
              const failingSince = context.failingSince ?? now;
              enq.raise({ type: "ARM_RETRY", position: failed.position });
              const backToIdleFailing = {
                ...backToIdle,
                context: { ...backToIdle.context, failingSince },
              };
              // During playback, newer saves replace the retry every few seconds; they stay quiet
              // until saves have failed for as long as the retry delay.
              if (
                failed.attempt === "retry" ||
                now - failingSince >= SAVE_RETRY_DELAY_MILLISECONDS
              ) {
                return withFailure(backToIdleFailing, self, SAVE_RETRY_FAILURE_MESSAGE);
              }
              return backToIdleFailing;
            },
          },
        },
      },
    },
    retry: {
      initial: "disarmed",
      on: {
        CLOSE: { target: ".disarmed" },
      },
      states: {
        disarmed: {
          on: {
            ARM_RETRY: ({ event, self }) => {
              if (isClosed(self)) {
                return undefined;
              }
              return { target: "armed", context: { retryPosition: event.position } };
            },
          },
        },
        armed: {
          invoke: {
            src: "retryTrigger",
            input: ({ context }) => ({ services: context.services }),
          },
          on: {
            // A newer save carries a later position.
            SAVE: { target: "disarmed" },
            RETRY_DUE: ({ context }) => {
              const retry: QueuedSave = {
                position: requireRetryPosition(context),
                attempt: "retry",
                resolveSave: () => undefined,
              };
              return {
                target: "disarmed",
                context: {
                  queue: [...context.queue, retry],
                  lastSavedAt: context.services.now(),
                  retryPosition: null,
                },
              };
            },
            ARM_RETRY: ({ event }) => ({
              target: "armed",
              reenter: true,
              context: { retryPosition: event.position },
            }),
          },
        },
      },
    },
    lifecycle: {
      initial: "open",
      states: {
        open: {
          on: { CLOSE: { target: "closed" } },
        },
        closed: {},
      },
    },
  },
});

/**
 * Reads the `lifecycle` region from the last committed snapshot, which is current wherever this is
 * called: only `CLOSE` moves `lifecycle`, and no save event (`SAVE`, a written or failed save,
 * `ARM_RETRY`, `RETRY_DUE`) is handled in the same step as a `CLOSE`.
 */
function isClosed(self: { getSnapshot: () => { matches: (value: object) => boolean } }) {
  return self.getSnapshot().matches({ lifecycle: "closed" });
}

/** Adds a failure to show the listener to a transition; a closed session reports nothing more. */
function withFailure<Transition extends { context: object }>(
  transition: Transition,
  self: Parameters<typeof isClosed>[0],
  failure: string,
) {
  if (isClosed(self)) {
    return transition;
  }
  return { ...transition, context: { ...transition.context, saveFailure: failure } };
}

/** `armed` exists only with the position its retry saves. */
function requireRetryPosition({ retryPosition }: PositionSavesContext): PlaybackPosition {
  if (!retryPosition) {
    throw new Error("Expected the position of the armed retry.");
  }
  return retryPosition;
}

/** `writing` exists only while a save is queued. */
function requireNextSave({ queue }: PositionSavesContext): QueuedSave {
  const [next] = queue;
  if (!next) {
    throw new Error("Expected a queued save to write.");
  }
  return next;
}
