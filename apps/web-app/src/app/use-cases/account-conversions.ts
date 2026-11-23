import React from "react";

import type { SignInMethod } from "#src/auth/account-session.js";
import { useAccountSession, useAccountAuthState, useSignInMethods } from "#src/auth/hooks.js";
import {
  clearPendingAccountConversion,
  readPendingAccountConversion,
  storePendingAccountConversion,
  type PendingAccountConversion,
} from "#src/data-fetching/account-conversion-storage.js";
import {
  useSignInMutation,
  useStartAccountConversionMutation,
} from "#src/data-fetching/account.js";
import { useRateLimitCountdown } from "#src/data-fetching/rate-limit.js";

export type SignInEntry = "home-link" | "submission";

type PendingRequestStore = {
  read: () => PendingAccountConversion | null;
  store: (request: PendingAccountConversion) => void;
  clear: () => void;
};

const SESSION_REQUEST_STORE: PendingRequestStore = {
  read: readPendingAccountConversion,
  store: storePendingAccountConversion,
  clear: clearPendingAccountConversion,
};

export function useAccountConversionSubmission({
  requestStorage,
  onStarted,
  onSignedInFromLink,
}: {
  requestStorage: "session" | "memory";
  onStarted: (conversionId: string) => Promise<void>;
  onSignedInFromLink?: () => Promise<void>;
}) {
  const session = useAccountSession();
  const authState = useAccountAuthState();
  const signIn = useSignInMutation();
  const signInMethods = useSignInMethods();
  const start = useStartAccountConversionMutation(onStarted);
  const retryIn = useRateLimitCountdown(start.error);

  const [isSignInOpen, setIsSignInOpen] = React.useState(false);
  const [signInEntry, setSignInEntry] = React.useState<SignInEntry>("submission");
  const resumed = React.useRef(false);
  const isSigningInFromLink = React.useRef(false);
  const requests = React.useMemo(
    () => (requestStorage === "session" ? SESSION_REQUEST_STORE : createMemoryRequestStore()),
    [requestStorage],
  );

  React.useEffect(() => {
    const request = requests.read();
    if (session && request?.submitted && !resumed.current) {
      resumed.current = true;
      start.mutate({ ...request, subject: session.user.id });
    }
  }, [requests, session, start]);

  React.useEffect(() => {
    if (!session || !isSigningInFromLink.current || requests.read()?.submitted) {
      return;
    }
    isSigningInFromLink.current = false;
    void onSignedInFromLink?.();
  }, [onSignedInFromLink, requests, session]);

  return {
    initialSourceUrl: requests.read()?.sourceUrl ?? "",
    isPending: start.isPending || authState.status === "loading",
    isAuthLoading: authState.status === "loading",
    retryIn,
    error: start.error,
    isSignInOpen: isSignInOpen && !session,
    signInEntry,
    canSignIn: !session && authState.status !== "loading",
    signIn,
    startSignIn: (method: SignInMethod) => {
      if (signInEntry === "home-link") {
        if (requests.read()?.submitted === false) {
          requests.clear();
        }

        isSigningInFromLink.current = true;
      }

      signIn.mutate(method);
    },
    signInMethods,
    submit: async ({ sourceUrl: input }: { sourceUrl: string }) => {
      if (start.isPending || retryIn > 0 || authState.status === "loading") {
        return;
      }
      signIn.reset();
      const sourceUrl = new URL(input).toString();
      const stored = requests.read();
      const request = {
        sourceUrl,
        idempotencyKey:
          stored?.sourceUrl === sourceUrl ? stored.idempotencyKey : crypto.randomUUID(),
        submitted: true,
      };
      requests.store(request);
      if (!session) {
        resumed.current = false;
        setSignInEntry("submission");
        setIsSignInOpen(true);
        return;
      }
      resumed.current = true;
      await start.mutateAsync({ ...request, subject: session.user.id }).catch(() => {});
    },
    openSignIn: () => {
      signIn.reset();
      setSignInEntry("home-link");
      setIsSignInOpen(true);
    },
    cancelSignIn: () => {
      if (signIn.isPending) {
        return;
      }
      const request = requests.read();
      if (signInEntry === "submission" && request) {
        requests.store({ ...request, submitted: false });
      }
      setIsSignInOpen(false);
    },
  };
}

function createMemoryRequestStore(): PendingRequestStore {
  let current: PendingAccountConversion | null = null;
  return {
    read: () => current,
    store: (request) => {
      current = request;
    },
    clear: () => {
      current = null;
    },
  };
}
