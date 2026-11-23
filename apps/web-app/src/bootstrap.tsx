import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";

import { AppStyles } from "#src/app/app-styles.js";
import { ErrorScreen } from "#src/app/components/error-message.js";
import { createAppRouter, GlobalProviders } from "#src/app/global-providers.js";
import { ensureAuthInitialized, sessionSnapshot } from "#src/auth/account-session.js";
import { watchAppleSignInsDuringDeletion } from "#src/data-fetching/apple-sign-in-revocation.js";
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
  reportError(error);
});

watchAppleSignInsDuringDeletion();

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
  await ensureAuthInitialized().catch(
    reportFailure("Failed to restore the account session before taking a share"),
  );
  if (sessionSnapshot()) {
    await router.navigate({ to: "/recent/add" });
    return;
  }
  await router.navigate({ to: "/" });
}

const captureReactError = Sentry.reactErrorHandler((error: unknown) => {
  reportError(error);
});
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
