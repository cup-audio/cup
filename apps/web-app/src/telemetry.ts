import * as Sentry from "@sentry/capacitor";
import * as SentryReact from "@sentry/react";

import {
  createClientSentryOptions,
  followAccountSession,
  readWebRelease,
} from "@cup/telemetry.browser";

import type { createAppRouter } from "#src/app/global-providers.js";
import { sessionSnapshot, subscribeAuthState } from "#src/auth/account-session.js";
import { requestApi } from "#src/data-fetching/api-request.js";
import { apiOrigin } from "#src/platform/api-origin.js";

/**
 * Starts Sentry for the web app, and does nothing outside production: the browser sends only from
 * `https://cup.audio`. Call it once, right after the router exists and before the platform
 * listeners start, so their failures are captured. From then on, telemetry's user follows the
 * account session by the user rule of `@cup/telemetry.browser`.
 */
export function initializeTelemetry(router: ReturnType<typeof createAppRouter>): void {
  const options = createClientSentryOptions({
    pageOrigin: window.location.origin,
    apiOrigin: apiOrigin(),
    release: readWebRelease(document),
    router,
  });
  if (options === undefined) {
    return;
  }

  Sentry.init(options, SentryReact.init);
  followAccountSession(
    {
      currentSubject: () => sessionSnapshot()?.user.id ?? null,
      subscribe: subscribeAuthState,
      // Not through the query cache, so the account settings still load a fresh snapshot.
      loadAccountId: async (subject) =>
        (await requestApi({ subject }, (client) => client.getAccount())).accountId,
    },
    Sentry.setUser,
  );
}
