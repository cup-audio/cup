import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Navigate,
  Outlet,
  useMatchRoute,
} from "@tanstack/react-router";
import React from "react";

import { NavigationProgressBar } from "#src/app/components/navigation-progress-bar.tsx";
import { StatusBarBackdrop } from "#src/app/components/status-bar-backdrop.tsx";
import { settleAccountRefusalAtHome, useAccountRefusal } from "#src/auth/account-admission.js";
import { ensureAuthInitialized } from "#src/auth/account-session.js";
import { useAccountSession } from "#src/auth/hooks.js";

type RouterContext = {
  queryClient: QueryClient;
};

/** Root route that supplies shared loader context and the application shell. */
export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  beforeLoad: ({ preload }) => {
    if (preload) {
      return;
    }

    // Start restoring auth without delaying page rendering; routes that need a session await it.
    // Initialization publishes failures to auth state, so they need not fail navigation here.
    void ensureAuthInitialized().catch(() => undefined);
  },
});

function RootLayout(): React.JSX.Element {
  return (
    <>
      <Outlet />
      <LeaveRefusedScreen />
      <StatusBarBackdrop />
      <NavigationProgressBar />
    </>
  );
}

/**
 * A screen that needed the account the API refused cannot be shown signed out, and its route's
 * error screen would not leave it; home opens the sign-in to say why (`account-conversions.ts`).
 */
function LeaveRefusedScreen(): React.ReactNode {
  const { shouldGoHome } = useAccountRefusal();
  const session = useAccountSession();
  const isHome = useMatchRoute()({ to: "/" }) !== false;

  React.useEffect(() => {
    if (isHome) {
      settleAccountRefusalAtHome();
    }
  }, [isHome]);

  return shouldGoHome && !session && !isHome ? <Navigate to="/" replace /> : null;
}
