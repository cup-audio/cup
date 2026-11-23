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

const TEST_SENTRY_DSN_GLOBAL = "cupTestSentryDsn";

export async function initializeTelemetry(
  router: ReturnType<typeof createAppRouter>,
): Promise<void> {
  const shell = await readShellContext();
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

  Sentry.init(options, (browserOptions) => {
    SentryReact.init(browserOptions);
    applyUserToNativeScope();
    if (processLoss !== undefined) {
      const { message, context } = webViewProcessLossMessage(processLoss);
      Sentry.captureMessage(message, context);
    }
  });
  followAccountSession(
    {
      currentSubject: () => sessionSnapshot()?.user.id ?? null,
      subscribe: subscribeAuthState,
      loadAccountId: async (subject) =>
        (await requestApi({ subject }, (client) => client.getAccount())).accountId,
    },
    Sentry.setUser,
  );
}

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

function applyUserToNativeScope(): void {
  const id = Sentry.getIsolationScope().getUser()?.id;
  if (typeof id === "string") {
    Sentry.setUser({ id });
  }
}
