import * as Sentry from "@sentry/react";
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

/** Settles the promise that a caller of the account session facade awaits for one request. */
export type Reply<Value> = {
  resolve: (value: Value) => void;
  reject: (error: unknown) => void;
};

/** The Supabase auth methods the machine calls itself; tests fake exactly these. */
export type AccountAuthClient = {
  auth: Pick<
    SupabaseClient["auth"],
    "getSession" | "onAuthStateChange" | "signOut" | "startAutoRefresh" | "stopAutoRefresh"
  >;
};

/** Google everywhere; the test account only where local development advertises it. */
export type SignInMethod = "google" | "test-account";
/** A fresh sign-in authenticates again even when the provider still has a session. */
export type SignInRequest = { method: SignInMethod; fresh: boolean };

/**
 * The device-local "choose account next" marker: sign-out sets it, so the next Google sign-in shows
 * Google's account chooser and the listener can switch accounts (ADR 0019). The next session that
 * starts clears it; a failed or cancelled sign-in keeps it.
 */
type AccountChooserMarker = {
  isSet: () => Promise<boolean>;
  set: () => Promise<void>;
  clear: () => Promise<void>;
};

/** What initialization produces: the Supabase client and the platform operations bound to it. */
export type AccountAuthConnection = {
  client: AccountAuthClient;
  /** The methods the auth configuration offers, in the order the sign-in dialog shows them. */
  signInMethods: readonly SignInMethod[];
  /** `chooseAccount` asks Google for its account chooser; the test account ignores it. */
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

/** Settles session reads for one session scope: `ready` forwards each `READ_SESSION` here. */
const sessionReadsLogic = createCallbackLogic<ReadSessionEvent, { client: AccountAuthClient }>(
  ({ input, receive }) => {
    const pendingReplies = new Set<Reply<Session | null>>();
    receive(({ reply }) => {
      pendingReplies.add(reply);
      void settleRead(input.client, reply, pendingReplies);
    });
    // The session scope ended while these reads were in flight: their result may belong to an
    // account that is no longer signed in.
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
      // The docs write payload-less events as `types<{}>()`, which the lint forbids as an empty type.
      INITIALIZE: z.object({}),
      SESSION_CHANGED: types<{ session: Session | null }>(),
      APP_STATE_CHANGED: types<{ isActive: boolean }>(),
      READ_SESSION: types<{ reply: Reply<Session | null> }>(),
      SIGN_IN: types<{ request: SignInRequest; reply: Reply<void> }>(),
      SIGN_OUT: types<{ reply: Reply<void> }>(),
    },
    // Types `children.sessionReads` for the `READ_SESSION` forwarding in `ready`.
    children: { sessionReads: types<ActorRefFrom<typeof sessionReadsLogic>>() },
  },
  actors: {
    loadConnection: createAsyncLogic<AccountAuthConnection>({
      run: () => Promise.reject(missingImplementation("loadConnection")),
    }),
    clearNativeSignIn: createAsyncLogic<void>({
      run: () => Promise.reject(missingImplementation("clearNativeSignIn")),
    }),
    /**
     * Reports `APP_STATE_CHANGED` when the app shell comes to the foreground or goes to the
     * background, including its state at the start. The web reports nothing: supabase-js follows
     * the page's visibility itself.
     */
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
    // The provider call cannot be recalled, so the caller learns its real outcome even when the
    // session scope ends first and this actor is stopped.
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
    // On the web, refresh is left to supabase-js: `stopAutoRefresh` would remove its visibility
    // handling until the next page load. Without a session, its refresh has nothing to do.
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
  // Effects that reach outside the auth client; `account-session.ts` provides them. Each is typed
  // `void`: a placeholder that only throws would infer `never`, which `provide` would then require.
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

/**
 * The account auth lifecycle of the web app.
 *
 * The machine moves through uninitialized → initializing → connected, with a retryable `error`
 * state when initialization fails. `connected` subscribes to Supabase auth changes once and
 * alternates between ready (signedOut ⇄ signingIn → signedIn) and signingOut. A sign-out requested
 * before initialization finishes is queued and runs as soon as the client is connected. `ready` is
 * one session scope: its session reads stop when the scope ends, which happens when a sign-in
 * starts, a sign-out starts, or a signed-in subject changes. A read that is still in flight then
 * resolves to `null` instead of returning a stale session.
 *
 * Effects that touch the network, the platform, the query cache, or playback are placeholders here;
 * `account-session.ts` provides them through `machine.provide(...)` and tests provide fakes.
 */
export const accountSessionMachine = accountSessionSetup.createMachine({
  id: "accountSession",
  context: INITIAL_CONTEXT,
  initial: "uninitialized",
  // Fallbacks for states without a session scope. The facade initializes before it sends these.
  on: {
    // Sign-out is clearing the session, or there is none yet; there is no session to read.
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
        // Sign-out shows signed-out and stops audio before it waits for initialization.
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
              // A sign-out requested during initialization discards the restored session.
              if (context.signOutReplies.length > 0) {
                return { target: "#accountSession.connected" };
              }

              // Route loaders can await the initial restoration, so it keeps cached queries.
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
      // Subscribed once per client: auth changes reach only the states that handle them, so
      // changes reported during sign-out are ignored without unsubscribing.
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
                // Unhandled: the event goes to the parent state, as a failed v5 guard did.
                return undefined;
              }

              // A different subject, or none, replaces the signed-in account: end its scope.
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
                    // Unhandled: the event goes to the parent state, as a failed v5 guard did.
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
                // The actor settles the caller's reply itself.
                onDone: { target: "routing", context: { signIn: undefined } },
                onError: { target: "routing", context: { signIn: undefined } },
              },
              on: {
                // Concurrent OAuth flows would overwrite each other's PKCE code verifier.
                SIGN_IN: ({ event }, enq) => {
                  enq(() =>
                    event.reply.reject(new Error("Wait for the current sign-in to finish.")),
                  );
                },
                // The provider reports the new session before the sign-in call returns.
                SESSION_CHANGED: ({ context, event, actions }, enq) => {
                  if (!startsSession(context.session, event.session)) {
                    // Unhandled: the event goes to the parent state, as a failed v5 guard did.
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
            // Joins the sign-out in progress; playback was stopped when it started.
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
            // Ends the platform's own sign-in, so the next sign-in can pick another account.
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

/** Derives the state the UI shows; the facade keeps the result referentially stable. */
export function selectAuthState(snapshot: AccountSessionSnapshot): AccountAuthState {
  if (snapshot.matches("error")) {
    return {
      status: "error",
      error: snapshot.context.initializationError ?? SIGN_IN_UNAVAILABLE,
    };
  }
  // A sign-out requested during initialization shows signed-out before initialization finishes.
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
  /**
   * Whether the app shell was last reported in the foreground: `undefined` until the shell reports,
   * and always on the web, where supabase-js drives refresh by the page's visibility.
   */
  isAppActive: boolean | undefined;
};

type ReadSessionEvent = { type: "READ_SESSION"; reply: Reply<Session | null> };
type SessionChangedEvent = { type: "SESSION_CHANGED"; session: Session | null };
type AppStateChangedEvent = { type: "APP_STATE_CHANGED"; isActive: boolean };

/** The effects every session that starts runs, whether restored, signed in or switched to. */
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

// A web sign-in returns before Google does, so only a session that starts shows the sign-in
// succeeded.
function clearAccountChooserMarker(context: AccountSessionContext) {
  requireConnection(context)
    .accountChooserMarker.clear()
    .catch(reportFailure("Failed to clear the account chooser marker"));
}

// Sign-out stopped the app shells' auto refresh; a session that starts in the foreground needs
// it again. On the web, no app state is reported, so supabase-js keeps driving refresh.
function restartAutoRefreshInForeground(context: AccountSessionContext) {
  if (context.isAppActive === true) {
    requireConnection(context)
      .client.auth.startAutoRefresh()
      .catch(reportFailure("Failed to start the session's auto refresh"));
  }
}

/**
 * In the app shells, refresh runs only in the foreground, as supabase-js does for a visible page.
 * Calling `startAutoRefresh` also removes supabase-js's own visibility handling, which a WebView's
 * page visibility would otherwise drive.
 */
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

/**
 * Captures the failure of an effect that nothing awaits, so its rejection stays observable. The
 * machine's own copy of `reportFailure` in `#src/report-failure.js`: its tests load this module
 * under Node, which resolves no `.js` import of the app.
 */
function reportFailure(message: string) {
  return (error: unknown) => {
    Sentry.captureException(new Error(message, { cause: error }));
  };
}

function toError(error: unknown) {
  return error instanceof Error ? error : SIGN_IN_UNAVAILABLE;
}

function missingImplementation(name: string) {
  return new Error(`Provide "${name}" through accountSessionMachine.provide(...).`);
}
