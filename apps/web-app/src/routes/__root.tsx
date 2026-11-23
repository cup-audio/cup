import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import React from "react";

import { NavigationProgressBar } from "#src/app/components/navigation-progress-bar.tsx";
import { StatusBarBackdrop } from "#src/app/components/status-bar-backdrop.tsx";
import { ensureAuthInitialized } from "#src/auth/account-session.js";

type RouterContext = {
  queryClient: QueryClient;
};

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  beforeLoad: ({ preload }) => {
    if (preload) {
      return;
    }

    void ensureAuthInitialized().catch(() => undefined);
  },
});

function RootLayout(): React.JSX.Element {
  return (
    <>
      <Outlet />
      <StatusBarBackdrop />
      <NavigationProgressBar />
    </>
  );
}
