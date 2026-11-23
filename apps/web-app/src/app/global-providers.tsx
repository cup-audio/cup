import { Toast } from "@base-ui/react/toast";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouteMask, createRouter, RouterProvider } from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";
import React from "react";

import { RouteErrorScreen } from "#src/app/components/error-message.js";
import { createCoverViewTransition } from "#src/app/cover-transition.js";
import { DSToastViewport } from "#src/app/design-system/toast.js";
import { queryClient } from "#src/data-fetching/query-client.js";
import { toastManager } from "#src/notifications.js";
import { routeTree } from "#src/routeTree.gen.js";

const addDialogMask = createRouteMask({ routeTree, from: "/recent/add", to: "/recent" });

export function createAppRouter(
  history?: RouterHistory,
  { pageOrigin = window.origin }: { pageOrigin?: string } = {},
) {
  const router = createRouter({
    basepath: "/app",
    ...(history && { history }),
    origin: routerOrigin(pageOrigin),
    context: {
      queryClient,
    },
    defaultErrorComponent: RouteErrorScreen,
    defaultPendingMinMs: 300,
    defaultPendingMs: 500,
    defaultPreload: "viewport",
    defaultPreloadStaleTime: 0,
    routeTree,
    routeMasks: [addDialogMask],
    scrollRestoration: true,
  });
  router.update({ ...router.options, defaultViewTransition: createCoverViewTransition(router) });
  return router;
}

declare module "@tanstack/react-router" {
  // oxlint-disable typescript/consistent-type-definitions -- TanStack Router requires interface merging to register the router's inferred type.
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
  interface HistoryState {
    isOpenedFromRecents?: boolean;
    isOpenedFromMiniPlayer?: boolean;
  }
  // oxlint-enable typescript/consistent-type-definitions
}

export function GlobalProviders({
  router,
}: {
  router: ReturnType<typeof createAppRouter>;
}): React.ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <Toast.Provider toastManager={toastManager}>
        <RouterProvider router={router} />
        <DSToastViewport />
      </Toast.Provider>
    </QueryClientProvider>
  );
}

function routerOrigin(pageOrigin: string): string {
  const isHttpOrigin = pageOrigin.startsWith("http://") || pageOrigin.startsWith("https://");
  return isHttpOrigin ? pageOrigin : "http://localhost";
}
