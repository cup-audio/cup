import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import * as Sentry from "@sentry/capacitor";
import * as SentryReact from "@sentry/react";

import {
  createClientSentryOptions,
  followAccountSession,
  readWebRelease,
  takeWebViewProcessLoss,
  webViewProcessLossMessage,
  type ShellTelemetryContext,
} from "@cup/telemetry.browser";

import type { createAppRouter } from "#src/app/global-providers.js";
import { sessionSnapshot, subscribeAuthState } from "#src/auth/account-session.js";
import { requestApi } from "#src/data-fetching/api-request.js";
import { apiOrigin } from "#src/platform/api-origin.js";
import { readCrashReportsEnabled } from "#src/platform/crash-reporting.js";

/**
 * Set before the page loads only by the debug build of a native shell that the mobile E2E suite
 * launched with the Sentry stub's DSN; release builds never set it.
 */
const TEST_SENTRY_DSN_GLOBAL = "cupTestSentryDsn";

/**
 * Starts Sentry for the web app, and does nothing outside production: the browser sends only from
 * `https://cup.audio`, a release shell only against it, and a debug shell only to the test DSN the
 * mobile E2E suite passed it. Call it once, right after the router exists and before the platform
 * listeners start, so their failures are captured. From then on, telemetry's user follows the
 * account session by the user rule of `@cup/telemetry.browser`. In a shell, it also reports, once,
 * a WebView process loss that the native side recorded before it brought the page back.
 */
export async function initializeTelemetry(
  router: ReturnType<typeof createAppRouter>,
): Promise<void> {
  const shell = await readShellContext();
  // Taken even when telemetry stays off, so a loss is never reported in a later start.
  const processLoss = shell === undefined ? undefined : await takeWebViewProcessLoss();
  const options = createClientSentryOptions({
    pageOrigin: window.location.origin,
    apiOrigin: apiOrigin(),
    release: readWebRelease(document),
    router,
    ...(shell === undefined ? {} : { shell }),
  });
  if (options === undefined) {
    return;
  }

  // The Capacitor SDK starts the browser SDK once the native SDK runs, or has failed to start.
  Sentry.init(options, (browserOptions) => {
    SentryReact.init(browserOptions);
    applyUserToNativeScope();
    if (processLoss !== undefined) {
      // The native side brought the page back after its WebView process died; this is the first
      // moment the event can be sent, through the tunnel like every JS event.
      const { message, context } = webViewProcessLossMessage(processLoss);
      Sentry.captureMessage(message, context);
    }
  });
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

/**
 * The shell's context, or `undefined` in the browser. Only an explicit `false` from the native
 * side's `Capacitor.DEBUG` counts as a release build. The "Send crash reports" switch is read here,
 * before `Sentry.init`, so turning it off takes effect on the next start.
 */
async function readShellContext(): Promise<ShellTelemetryContext | undefined> {
  if (!Capacitor.isNativePlatform()) {
    return undefined;
  }
  const [{ version, build }, shouldSendCrashReports] = await Promise.all([
    App.getInfo(),
    readCrashReportsEnabled(),
  ]);
  const testSentryDsn: unknown = Reflect.get(window, TEST_SENTRY_DSN_GLOBAL);
  return {
    isDebugBuild: Capacitor.DEBUG !== false,
    testSentryDsn: typeof testSentryDsn === "string" ? testSentryDsn : undefined,
    shouldSendCrashReports,
    app: { version, build },
  };
}

/**
 * Sets the current user again once the native SDK runs: a user set before then never reached the
 * native scope, and scope sync copies only later changes.
 */
function applyUserToNativeScope(): void {
  const id = Sentry.getIsolationScope().getUser()?.id;
  if (typeof id === "string") {
    Sentry.setUser({ id });
  }
}
