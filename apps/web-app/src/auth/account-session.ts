import * as Sentry from "@sentry/react";
import { createClient, type Session } from "@supabase/supabase-js";
import { createActor, createAsyncLogic, createCallbackLogic, waitFor } from "xstate";

import { parseOkResponse } from "@cup/listener-api.client";
import { authConfigResponseSchema } from "@cup/listener-api.routes";
import { clientSupabaseIntegration } from "@cup/telemetry.browser";

import { createListenerApiClient } from "#src/api-client.js";
import {
  accountSessionMachine,
  selectAuthState,
  type AccountAuthClient,
  type AccountAuthConnection,
  type AccountAuthState,
  type Reply,
  type SignInMethod,
} from "#src/auth/account-session-machine.js";
import {
  ACCOUNT_CHOOSER_MARKER_STORAGE_KEY,
  ACCOUNT_SESSION_CODE_VERIFIER_STORAGE_KEY,
  ACCOUNT_SESSION_STORAGE_KEY,
} from "#src/auth/account-session-storage.js";
import { queryClient } from "#src/data-fetching/query-client.js";
import {
  initializeAuthStorage,
  signInWithGoogle,
  clearNativeSignIn,
  watchAppState,
} from "#src/platform/account-auth.js";
import { STOP_PLAYBACK_EVENT_NAME } from "#src/playback-events.js";
import { trialBrowserState } from "#src/trial-browser-state.js";

export type { SignInMethod };

const accountSessionActor = createActor(
  accountSessionMachine.provide({
    actors: {
      loadConnection: createAsyncLogic({ run: loadConnection }),
      clearNativeSignIn: createAsyncLogic({ run: () => clearNativeSignIn() }),
      watchAppState: createCallbackLogic(({ sendBack }) =>
        watchAppState((isActive) => sendBack({ type: "APP_STATE_CHANGED", isActive })),
      ),
    },
    actions: {
      clearQueries: () => queryClient.clear(),
      stopPlayback,
      unloadAudio,
      clearLastGrantId: () => trialBrowserState.clearLastGrantId(),
    },
  }),
);
accountSessionActor.start();

let publishedAuthState = selectAuthState(accountSessionActor.getSnapshot());

export const authStateSnapshot = (): AccountAuthState => {
  const next = selectAuthState(accountSessionActor.getSnapshot());
  if (!isSameAuthState(publishedAuthState, next)) {
    publishedAuthState = next;
  }
  return publishedAuthState;
};
export const sessionSnapshot = () => {
  const state = authStateSnapshot();
  return state.status === "signed-in" ? state.session : null;
};
export const isSignedInAs = (subject: string) => sessionSnapshot()?.user.id === subject;
const DEFAULT_SIGN_IN_METHODS: readonly SignInMethod[] = ["google"];
export const signInMethodsSnapshot = () =>
  accountSessionActor.getSnapshot().context.connection?.signInMethods ?? DEFAULT_SIGN_IN_METHODS;
export const subscribeAuthState = (listener: () => void) => {
  let last = authStateSnapshot();
  const subscription = accountSessionActor.subscribe(() => {
    const next = authStateSnapshot();
    if (next !== last) {
      last = next;
      listener();
    }
  });
  return () => subscription.unsubscribe();
};

export async function ensureAuthInitialized(): Promise<AccountAuthClient> {
  accountSessionActor.send({ type: "INITIALIZE" });
  const snapshot = await waitFor(
    accountSessionActor,
    (current) => current.hasTag("initialized") || current.matches("error"),
  );
  const state = selectAuthState(snapshot);
  if (state.status === "error") {
    throw state.error;
  }
  if (!snapshot.context.connection) {
    throw new Error("Account auth finished initializing without a connection.");
  }
  return snapshot.context.connection.client;
}

export async function settleAccountSession(): Promise<Session | null> {
  await ensureAuthInitialized();
  return sessionSnapshot();
}

export async function getFreshAccountSession(): Promise<Session | null> {
  await ensureAuthInitialized();
  return request<Session | null>((reply) =>
    accountSessionActor.send({ type: "READ_SESSION", reply }),
  );
}

export async function getResourceAccountSession() {
  try {
    return await getFreshAccountSession();
  } catch (error) {
    if (sessionSnapshot()) {
      throw error;
    }
    return null;
  }
}

export async function signIn(method: SignInMethod) {
  await ensureAuthInitialized();
  return request<void>((reply) =>
    accountSessionActor.send({ type: "SIGN_IN", request: { method, fresh: false }, reply }),
  );
}

export async function signInAgain(method: SignInMethod) {
  await ensureAuthInitialized();
  return request<void>((reply) =>
    accountSessionActor.send({ type: "SIGN_IN", request: { method, fresh: true }, reply }),
  );
}

export function signOut() {
  return request<void>((reply) => accountSessionActor.send({ type: "SIGN_OUT", reply }));
}

async function loadConnection(): Promise<AccountAuthConnection> {
  const config = authConfigResponseSchema.parse(
    await parseOkResponse(createListenerApiClient().getAuthConfig()),
  );
  const platformStorage = await initializeAuthStorage([
    ACCOUNT_SESSION_STORAGE_KEY,
    ACCOUNT_SESSION_CODE_VERIFIER_STORAGE_KEY,
  ]);
  const client = createClient(config.supabaseUrl, config.publishableKey, {
    auth: {
      storageKey: ACCOUNT_SESSION_STORAGE_KEY,
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: platformStorage.detectSessionInUrl,
      storage: platformStorage.storage,
    },
  });
  Sentry.addIntegration(clientSupabaseIntegration(client));
  const { storage } = platformStorage;
  const { testAccount } = config;
  const signInMethods: SignInMethod[] = [];
  if (config.googleWebClientId) {
    signInMethods.push("google");
  }
  if (testAccount) {
    signInMethods.push("test-account");
  }
  return {
    client,
    signInMethods,
    signIn: async ({ method, fresh, chooseAccount }) => {
      if (method === "google") {
        await signInWithGoogle(client, config.googleWebClientId, { fresh, chooseAccount });
        return;
      }
      if (!testAccount) {
        throw new Error("Sign-in is temporarily unavailable.");
      }
      const result = await client.auth.signInWithPassword(testAccount);
      if (result.error) {
        throw result.error;
      }
    },
    clearStoredSession: platformStorage.clearStoredSession,
    accountChooserMarker: {
      isSet: async () => (await storage.getItem(ACCOUNT_CHOOSER_MARKER_STORAGE_KEY)) !== null,
      set: async () => {
        await storage.setItem(ACCOUNT_CHOOSER_MARKER_STORAGE_KEY, "true");
      },
      clear: async () => {
        await storage.removeItem(ACCOUNT_CHOOSER_MARKER_STORAGE_KEY);
      },
    },
  };
}

function request<Value>(send: (reply: Reply<Value>) => void) {
  return new Promise<Value>((resolve, reject) => send({ resolve, reject }));
}

function isSameAuthState(previous: AccountAuthState, next: AccountAuthState) {
  if (previous.status !== next.status) {
    return false;
  }
  if (previous.status === "signed-in" && next.status === "signed-in") {
    return previous.session === next.session;
  }
  if (previous.status === "error" && next.status === "error") {
    return previous.error === next.error;
  }
  return true;
}

function stopPlayback() {
  window.dispatchEvent(new Event(STOP_PLAYBACK_EVENT_NAME));
  for (const audio of document.querySelectorAll("audio")) {
    audio.pause();
  }
}

function unloadAudio() {
  for (const audio of document.querySelectorAll("audio")) {
    audio.removeAttribute("src");
    for (const source of audio.querySelectorAll("source")) {
      source.removeAttribute("src");
    }
    audio.load();
  }
}
