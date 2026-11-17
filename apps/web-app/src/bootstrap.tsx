import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";

import { AppStyles } from "#src/app/app-styles.js";
import { ErrorScreen } from "#src/app/components/error-message.js";
import { createAppRouter, GlobalProviders } from "#src/app/global-providers.js";
import { ensureAuthInitialized, sessionSnapshot } from "#src/auth/account-session.js";
import { initializeAndroidBackButton } from "#src/platform/back-button.android.js";
import { initializeIosIncomingUrls } from "#src/platform/incoming-urls.ios.js";
import { initializeAndroidShare } from "#src/platform/share-plugin.android.js";
import { reportFailure } from "#src/report-failure.js";
import { initializeTelemetry } from "#src/telemetry.js";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Expected #root element to exist.");
}

const router = createAppRouter();

await initializeTelemetry(router).catch((error: unknown) => {
  // Telemetry is off, so the failure to start it goes where the browser reports errors.
  reportError(error);
});

await initializeAndroidBackButton(router.history);

await Promise.all([
  initializeAndroidShare(navigateToConversionForShare).catch(
    reportFailure("Failed to initialize Android share intake"),
  ),
  initializeIosIncomingUrls(navigateToConversionForShare).catch(
    reportFailure("Failed to initialize iOS incoming URL handling"),
  ),
]);

async function navigateToConversionForShare(): Promise<void> {
  // A share can arrive at app start, before the restored session is known; failing auth counts as signed out.
  await ensureAuthInitialized().catch(
    reportFailure("Failed to restore the account session before taking a share"),
  );
  if (sessionSnapshot()) {
    // The Add dialog takes the shared URL; leaving it replaces this entry with Recents.
    await router.navigate({ to: "/recent/add" });
    return;
  }
  // The mobile apps intentionally don't support trial links, so a signed-out listener has no trial
  // here; the shared URL waits until a conversion form is opened.
  await router.navigate({ to: "/" });
}

/*
 * Sentry captures what React reports, then hands it on to `reportError`, React's own default, so the
 * browser still shows it; Sentry skips the error it already captured when the global handler sees it.
 */
const captureReactError = Sentry.reactErrorHandler((error: unknown) => {
  reportError(error);
});
// React's root options type the component stack as possibly undefined, Sentry's handler as null.
const reportReactError = (
  error: unknown,
  { componentStack }: { componentStack?: string | undefined },
) => {
  captureReactError(error, { componentStack: componentStack ?? null });
};

ReactDOM.createRoot(rootElement, {
  onUncaughtError: reportReactError,
  onRecoverableError: reportReactError,
}).render(
  <React.StrictMode>
    <AppStyles />
    <Sentry.ErrorBoundary
      fallback={({ error }) => (
        <ErrorScreen
          error={error}
          fallbackTitle="Cup stopped working."
          onRetry={() => window.location.reload()}
        />
      )}
    >
      <GlobalProviders router={router} />
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
);
