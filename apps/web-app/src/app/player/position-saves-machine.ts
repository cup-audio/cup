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

export const SAVE_RETRY_DELAY_MILLISECONDS = 15_000;
export const SAVE_RETRY_FAILURE_MESSAGE =
  "Your listening position could not be saved yet. Cup keeps trying.";
const SAVE_FAILURE_TITLE = "Your listening position could not be saved.";

type SaveAttempt = "new" | "retry";
type QueuedSave = {
  position: PlaybackPosition;
  attempt: SaveAttempt;
  resolveSave: () => void;
};

type PositionSavesContext = PositionSavesMachineInput & {
  queue: QueuedSave[];
  lastSavedAt: number;
  failingSince: number | null;
  saveFailure: string | null;
  retryPosition: PlaybackPosition | null;
};

const positionSavesSetup = setup({
  schemas: {
    context: types<PositionSavesContext>(),
    input: types<PositionSavesMachineInput>(),
    events: {
      SAVE: types<{ position: PlaybackPosition; resolveSave: () => void }>(),
      CLOSE: z.object({}),
      RETRY_DUE: z.object({}),
    },
    internalEvents: {
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
    retryTrigger: createCallbackLogic<{ type: "RETRY_DUE" }, { services: PlaybackSessionServices }>(
      ({ input: { services }, sendBack }) => {
        const retry = () => sendBack({ type: "RETRY_DUE" });
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
                return withFailure(backToIdle, self, description.detail ?? description.title);
              }

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

function isClosed(self: { getSnapshot: () => { matches: (value: object) => boolean } }) {
  return self.getSnapshot().matches({ lifecycle: "closed" });
}

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

function requireRetryPosition({ retryPosition }: PositionSavesContext): PlaybackPosition {
  if (!retryPosition) {
    throw new Error("Expected the position of the armed retry.");
  }
  return retryPosition;
}

function requireNextSave({ queue }: PositionSavesContext): QueuedSave {
  const [next] = queue;
  if (!next) {
    throw new Error("Expected a queued save to write.");
  }
  return next;
}
