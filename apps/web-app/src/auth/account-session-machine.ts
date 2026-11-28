import type { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  createAsyncLogic,
  createCallbackLogic,
  setup,
  types,
  type ActorRefFrom,
  type SnapshotFrom,
} from "xstate";
import { z } from "zod";

import { reportFailure } from "#src/report-failure.ts";

export type Reply<Value> = {
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
};

export type AccountAuthClient = {
  auth: Pick<
    SupabaseClient["auth"],
    "getSession" | "onAuthStateChange" | "signOut" | "startAutoRefresh" | "stopAutoRefresh"
  >;
};

export type SignInMethod = "apple" | "google" | "test-account";
export type SignInRequest = { method: SignInMethod; fresh: boolean };

type AccountChooserMarker = {
  isSet: () => Promise<boolean>;
  set: () => Promise<void>;
  clear: () => Promise<void>;
};

export type AccountAuthConnection = {
  client: AccountAuthClient;
  signInMethods: readonly SignInMethod[];
  signIn: (request: SignInRequest & { chooseAccount: boolean }) => Promise<void>;
  clearStoredSession: () => Promise<void>;
  accountChooserMarker: AccountChooserMarker;
};

export type AccountAuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; session: Session }
  | { status: "error"; error: Error };

export type AccountSessionSnapshot = SnapshotFrom<typeof accountSessionMachine>;

const SIGN_IN_UNAVAILABLE = new Error("Sign-in is temporarily unavailable.");
const NOT_INITIALIZED_MESSAGE = "Account auth is not initialized.";

const INITIAL_CONTEXT: AccountSessionContext = {
  connection: undefined,
  session: null,
  initializationError: undefined,
  signIn: undefined,
  signOutReplies: [],
  isRevocationConfirmed: false,
  isAppActive: undefined,
};

const sessionReadsLogic = createCallbackLogic<ReadSessionEvent, { client: AccountAuthClient }>(
  ({ input, receive }) => {
    const pendingReplies = new Set<Reply<Session | null>>();
    receive(({ reply }) => {
      pendingReplies.add(reply);
      void settleRead(input.client, reply, pendingReplies);
    });
    return () => {
      for (const reply of pendingReplies) {
        reply.resolve(null);
      }
      pendingReplies.clear();
    };
  },
);

const accountSessionSetup = setup({
  schemas: {
    context: types<AccountSessionContext>(),
    events: {
      INITIALIZE: z.object({}),
      SESSION_CHANGED: types<{ session: Session | null }>(),
      APP_STATE_CHANGED: types<{ isActive: boolean }>(),
      READ_SESSION: types<{ reply: Reply<Session | null> }>(),
      SIGN_IN: types<{ request: SignInRequest; reply: Reply<void> }>(),
      SIGN_OUT: types<{ reply: Reply<void> }>(),
    },
    children: { sessionReads: types<ActorRefFrom<typeof sessionReadsLogic>>() },
  },
  actors: {
    loadConnection: createAsyncLogic<AccountAuthConnection>({
      run: () => Promise.reject(missingImplementation("loadConnection")),
    }),
    clearNativeSignIn: createAsyncLogic<void>({
      run: () => Promise.reject(missingImplementation("clearNativeSignIn")),
    }),
    watchAppState: createCallbackLogic<AppStateChangedEvent>(() => {
      throw missingImplementation("watchAppState");
    }),
    readSession: createAsyncLogic<Session | null, { client: AccountAuthClient }>({
      run: async ({ input }) => readSession(input.client),
    }),
    watchSessionChanges: createCallbackLogic<SessionChangedEvent, { client: AccountAuthClient }>(
      ({ input, sendBack }) => {
        const { data } = input.client.auth.onAuthStateChange((_event, session) => {
          sendBack({ type: "SESSION_CHANGED", session });
        });
        return () => data.subscription.unsubscribe();
      },
    ),
    sessionReads: sessionReadsLogic,
    signIn: createAsyncLogic<
      void,
      { connection: AccountAuthConnection; request: SignInRequest; reply: Reply<void> }
    >({
      run: async ({ input }) => {
        try {
          const chooseAccount = await input.connection.accountChooserMarker.isSet();
          await input.connection.signIn({ ...input.request, chooseAccount });
          input.reply.resolve();
        } catch (error) {
          input.reply.reject(error);
          throw error;
        }
      },
    }),
    revokeSession: createAsyncLogic<
      { isRevocationConfirmed: boolean },
      { connection: AccountAuthConnection; isRefreshDrivenByAppState: boolean }
    >({
      run: async ({ input: { connection, isRefreshDrivenByAppState } }) => {
        const response = await connection.client.auth.signOut({ scope: "local" });
        if (isRefreshDrivenByAppState) {
          await connection.client.auth.stopAutoRefresh();
        }

        await connection.clearStoredSession();
        await connection.accountChooserMarker.set();
        return { isRevocationConfirmed: !response.error };
      },
    }),
  },
  actions: {
    clearQueries: (): void => {
      throw missingImplementation("clearQueries");
    },
    stopPlayback: (): void => {
      throw missingImplementation("stopPlayback");
    },
    unloadAudio: (): void => {
      throw missingImplementation("unloadAudio");
    },
    clearLastGrantId: (): void => {
      throw missingImplementation("clearLastGrantId");
    },
  },
});

export const accountSessionMachine = accountSessionSetup.createMachine({
  id: "accountSession",
  context: INITIAL_CONTEXT,
  initial: "uninitialized",
  on: {
    READ_SESSION: ({ event }, enq) => {
      enq(() => event.reply.resolve(null));
    },
    SIGN_IN: ({ event }, enq) => {
      enq(() => event.reply.reject(new Error(NOT_INITIALIZED_MESSAGE)));
    },
  },
  states: {
    uninitialized: {
      on: {
        INITIALIZE: { target: "initializing" },
        SIGN_OUT: ({ context, event, actions }, enq) => {
          enq(actions.stopPlayback);
          enq(actions.unloadAudio);
          return { target: "initializing", context: queueSignOut(context, event.reply) };
        },
      },
    },
    initializing: {
      initial: "connecting",
      on: {
        SIGN_OUT: ({ context, event, actions }, enq) => {
          enq(actions.stopPlayback);
          enq(actions.unloadAudio);
          return { context: queueSignOut(context, event.reply) };
        },
      },
      states: {
        connecting: {
          invoke: {
            src: "loadConnection",
            onDone: ({ event }) => ({
              target: "restoringSession",
              context: { connection: event.output },
            }),
            onError: ({ context, event }, enq) => {
              enq(() => rejectAll(context.signOutReplies, event.error));
              return {
                target: "#accountSession.error",
                context: { initializationError: toError(event.error), signOutReplies: [] },
              };
            },
          },
        },
        restoringSession: {
          invoke: {
            src: "readSession",
            input: ({ context }) => ({ client: requireConnection(context).client }),
            onDone: ({ context, event, actions }, enq) => {
              if (context.signOutReplies.length > 0) {
                return { target: "#accountSession.connected" };
              }

              enq(actions.stopPlayback);
              if (event.output) {
                enqueueSessionStart(enq, actions, context);
              }
              return { target: "#accountSession.connected", context: { session: event.output } };
            },
            onError: ({ context, event }, enq) => {
              enq(() => rejectAll(context.signOutReplies, event.error));
              return {
                target: "#accountSession.error",
                context: { initializationError: toError(event.error), signOutReplies: [] },
              };
            },
          },
        },
      },
    },
    error: {
      on: {
        INITIALIZE: { target: "initializing", context: { initializationError: undefined } },
        SIGN_OUT: ({ context, event, actions }, enq) => {
          enq(actions.stopPlayback);
          enq(actions.unloadAudio);
          return {
            target: "initializing",
            context: { initializationError: undefined, ...queueSignOut(context, event.reply) },
          };
        },
      },
    },
    connected: {
      tags: ["initialized"],
      initial: "starting",
      invoke: [
        {
          src: "watchSessionChanges",
          input: ({ context }) => ({ client: requireConnection(context).client }),
        },
        { src: "watchAppState" },
      ],
      on: {
        APP_STATE_CHANGED: ({ context, event }, enq) => {
          enq(() => followAppState(context, event.isActive));
          return { context: { isAppActive: event.isActive } };
        },
      },
      states: {
        starting: {
          type: "choice",
          choice: ({ context }) =>
            context.signOutReplies.length > 0 ? { target: "signingOut" } : { target: "ready" },
        },
        ready: {
          initial: "routing",
          invoke: {
            id: "sessionReads",
            src: "sessionReads",
            input: ({ context }) => ({ client: requireConnection(context).client }),
          },
          on: {
            READ_SESSION: ({ children, event }, enq) => {
              enq.sendTo(children.sessionReads, event);
            },
            SESSION_CHANGED: ({ context, event, actions }, enq) => {
              if (isSameSubject(context.session, event.session)) {
                return { context: { session: event.session } };
              }
              if (context.session === null) {
                return undefined;
              }

              enq(actions.clearQueries);
              enq(actions.stopPlayback);
              if (event.session) {
                enqueueSessionStart(enq, actions, context);
              }
              return {
                target: "#accountSession.connected.ready",
                reenter: true,
                context: { signIn: undefined, session: event.session },
              };
            },
            SIGN_IN: ({ event, actions }, enq) => {
              enq(actions.stopPlayback);
              return {
                target: ".signingIn",
                reenter: true,
                context: { signIn: { request: event.request, reply: event.reply } },
              };
            },
            SIGN_OUT: ({ context, event, actions }, enq) => {
              if (context.session) {
                enq(actions.clearQueries);
              }
              enq(actions.stopPlayback);
              enq(actions.unloadAudio);
              return {
                target: "#accountSession.connected.signingOut",
                context: { signIn: undefined, ...queueSignOut(context, event.reply) },
              };
            },
          },
          states: {
            routing: {
              type: "choice",
              choice: ({ context }) =>
                context.session === null ? { target: "signedOut" } : { target: "signedIn" },
            },
            signedOut: {
              on: {
                SESSION_CHANGED: ({ context, event, actions }, enq) => {
                  if (!startsSession(context.session, event.session)) {
                    return undefined;
                  }

                  enq(actions.stopPlayback);
                  enqueueSessionStart(enq, actions, context);
                  return { target: "signedIn", context: { session: event.session } };
                },
              },
            },
            signingIn: {
              invoke: {
                src: "signIn",
                input: ({ context }) => ({
                  connection: requireConnection(context),
                  ...requireSignIn(context),
                }),
                onDone: { target: "routing", context: { signIn: undefined } },
                onError: { target: "routing", context: { signIn: undefined } },
              },
              on: {
                SIGN_IN: ({ event }, enq) => {
                  enq(() =>
                    event.reply.reject(new Error("Wait for the current sign-in to finish.")),
                  );
                },
                SESSION_CHANGED: ({ context, event, actions }, enq) => {
                  if (!startsSession(context.session, event.session)) {
                    return undefined;
                  }

                  enq(actions.stopPlayback);
                  enqueueSessionStart(enq, actions, context);
                  return { context: { session: event.session } };
                },
              },
            },
            signedIn: {},
          },
        },
        signingOut: {
          initial: "revokingSession",
          on: {
            SIGN_IN: ({ event }, enq) => {
              enq(() =>
                event.reply.reject(new Error("Wait for sign-out to finish before signing in.")),
              );
            },
            SIGN_OUT: ({ context, event }) => ({ context: queueSignOut(context, event.reply) }),
          },
          states: {
            revokingSession: {
              invoke: {
                src: "revokeSession",
                input: ({ context }) => ({
                  connection: requireConnection(context),
                  isRefreshDrivenByAppState: context.isAppActive !== undefined,
                }),
                onDone: ({ event, actions }, enq) => {
                  enq(actions.clearLastGrantId);
                  return {
                    target: "clearingNativeSignIn",
                    context: { isRevocationConfirmed: event.output.isRevocationConfirmed },
                  };
                },
                onError: ({ context, event }, enq) => {
                  enq(() => rejectAll(context.signOutReplies, event.error));
                  return {
                    target: "#accountSession.connected.ready",
                    context: { signOutReplies: [] },
                  };
                },
              },
            },
            clearingNativeSignIn: {
              invoke: {
                src: "clearNativeSignIn",
                onDone: ({ context }, enq) => {
                  const replies = context.signOutReplies;
                  if (context.isRevocationConfirmed) {
                    enq(() => resolveAll(replies));
                  } else {
                    enq(() =>
                      rejectAll(
                        replies,
                        new Error(
                          "Signed out on this device. Server session revocation could not be confirmed.",
                        ),
                      ),
                    );
                  }
                  return {
                    target: "#accountSession.connected.ready",
                    context: { signOutReplies: [] },
                  };
                },
                onError: ({ context, event }, enq) => {
                  enq(() => rejectAll(context.signOutReplies, event.error));
                  return {
                    target: "#accountSession.connected.ready",
                    context: { signOutReplies: [] },
                  };
                },
              },
            },
          },
        },
      },
    },
  },
});

export function selectAuthState(snapshot: AccountSessionSnapshot): AccountAuthState {
  if (snapshot.matches("error")) {
    return {
      status: "error",
      error: snapshot.context.initializationError ?? SIGN_IN_UNAVAILABLE,
    };
  }
  if (snapshot.context.signOutReplies.length > 0) {
    return { status: "signed-out" };
  }
  if (!snapshot.hasTag("initialized")) {
    return { status: "loading" };
  }
  const { session } = snapshot.context;
  return session ? { status: "signed-in", session } : { status: "signed-out" };
}

type AccountSessionContext = {
  connection: AccountAuthConnection | undefined;
  session: Session | null;
  initializationError: Error | undefined;
  signIn: { request: SignInRequest; reply: Reply<void> } | undefined;
  signOutReplies: readonly Reply<void>[];
  isRevocationConfirmed: boolean;
  isAppActive: boolean | undefined;
};

type ReadSessionEvent = { type: "READ_SESSION"; reply: Reply<Session | null> };
type SessionChangedEvent = { type: "SESSION_CHANGED"; session: Session | null };
type AppStateChangedEvent = { type: "APP_STATE_CHANGED"; isActive: boolean };

function enqueueSessionStart(
  enqueue: (effect: () => void) => void,
  actions: { clearLastGrantId: () => void },
  context: AccountSessionContext,
) {
  enqueue(actions.clearLastGrantId);
  enqueue(() => clearAccountChooserMarker(context));
  enqueue(() => restartAutoRefreshInForeground(context));
}

function queueSignOut(context: AccountSessionContext, reply: Reply<void>) {
  return {
    session: null,
    isRevocationConfirmed: false,
    signOutReplies: [...context.signOutReplies, reply],
  };
}

function isSameSubject(current: Session | null, next: Session | null) {
  return (next?.user.id ?? null) === (current?.user.id ?? null);
}

function startsSession(current: Session | null, next: Session | null) {
  return current === null && next !== null;
}

function clearAccountChooserMarker(context: AccountSessionContext) {
  requireConnection(context)
    .accountChooserMarker.clear()
    .catch(reportFailure("Failed to clear the account chooser marker"));
}

function restartAutoRefreshInForeground(context: AccountSessionContext) {
  if (context.isAppActive === true) {
    requireConnection(context)
      .client.auth.startAutoRefresh()
      .catch(reportFailure("Failed to start the session's auto refresh"));
  }
}

function followAppState(context: AccountSessionContext, isActive: boolean) {
  const { auth } = requireConnection(context).client;
  (isActive ? auth.startAutoRefresh() : auth.stopAutoRefresh()).catch(
    reportFailure("Failed to follow the app state with the session's auto refresh"),
  );
}

async function readSession(client: AccountAuthClient) {
  const result = await client.auth.getSession();
  if (result.error) {
    throw result.error;
  }
  return result.data.session;
}

async function settleRead(
  client: AccountAuthClient,
  reply: Reply<Session | null>,
  pendingReplies: Set<Reply<Session | null>>,
) {
  try {
    const session = await readSession(client);
    if (pendingReplies.delete(reply)) {
      reply.resolve(session);
    }
  } catch (error) {
    if (pendingReplies.delete(reply)) {
      reply.reject(error);
    }
  }
}

function requireConnection(context: AccountSessionContext) {
  if (!context.connection) {
    throw new Error(NOT_INITIALIZED_MESSAGE);
  }
  return context.connection;
}

function requireSignIn(context: AccountSessionContext) {
  if (!context.signIn) {
    throw new Error("No sign-in is in progress.");
  }
  return context.signIn;
}

function resolveAll(replies: readonly Reply<void>[]) {
  for (const reply of replies) {
    reply.resolve();
  }
}

function rejectAll(replies: readonly Reply<void>[], error: unknown) {
  for (const reply of replies) {
    reply.reject(error);
  }
}

function toError(error: unknown) {
  return error instanceof Error ? error : SIGN_IN_UNAVAILABLE;
}

function missingImplementation(name: string) {
  return new Error(`Provide "${name}" through accountSessionMachine.provide(...).`);
}
