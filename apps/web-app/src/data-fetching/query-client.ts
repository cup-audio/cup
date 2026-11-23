import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { RpcError } from "@cup/listener-api.client";

import { notifyError, toastManager } from "#src/notifications.js";

type ErrorDisplayMeta = {
  errorDisplay?: "inline";
  errorTitle?: string;
};

declare module "@tanstack/react-query" {
  // oxlint-disable typescript/consistent-type-definitions -- TanStack Query requires interface merging to register meta types.
  interface Register {
    queryMeta: ErrorDisplayMeta;
    mutationMeta: ErrorDisplayMeta;
  }
  // oxlint-enable typescript/consistent-type-definitions
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (query.state.data !== undefined && isAccessLost(error)) {
        query.setState({ data: undefined, dataUpdatedAt: 0 });
        return;
      }

      if (query.state.data === undefined || query.meta?.errorDisplay === "inline") {
        return;
      }

      notifyError(error, { title: query.meta?.errorTitle, id: toastIdOfQuery(query.queryHash) });
    },
    onSuccess: (_data, query) => toastManager.close(toastIdOfQuery(query.queryHash)),
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.errorDisplay === "inline") {
        return;
      }

      notifyError(error, { title: mutation.meta?.errorTitle });
    },
  }),
  defaultOptions: {
    mutations: {
      retry: false,
    },
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      gcTime: Infinity,
      staleTime: 0,
    },
  },
});

function isAccessLost(error: unknown): boolean {
  return error instanceof RpcError && (error.status === 403 || error.status === 404);
}

function toastIdOfQuery(queryHash: string) {
  return `query:${queryHash}`;
}
