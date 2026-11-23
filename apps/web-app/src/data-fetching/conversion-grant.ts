import { queryOptions, useMutation } from "@tanstack/react-query";
import React from "react";

import {
  grantSnapshotSchema,
  startConversionResponseSchema,
  type GrantSnapshot,
  type StartConversionResponse,
} from "@cup/listener-api.routes";

import { requestApi } from "#src/data-fetching/api-request.js";
import { queryClient } from "#src/data-fetching/query-client.js";
import { QUERY_KEYS } from "#src/data-fetching/query-keys.js";

export function createGrantQuery(grantId: string) {
  return queryOptions({
    queryKey: QUERY_KEYS.grant(grantId),
    queryFn: ({ signal }) => getGrant(grantId, signal),
    meta: { errorTitle: "The trial could not be updated." },
  });
}

export function useStartTrialConversionMutation(
  grantId: string,
  { onStarted }: { onStarted: (conversionId: string) => Promise<void> },
) {
  const pending = React.useRef<{
    grantId: string;
    sourceUrl: string;
    idempotencyKey: string;
  } | null>(null);
  return useMutation({
    meta: { errorDisplay: "inline" },
    mutationFn: async (sourceUrl: string) => {
      if (pending.current?.grantId !== grantId || pending.current.sourceUrl !== sourceUrl) {
        pending.current = { grantId, sourceUrl, idempotencyKey: crypto.randomUUID() };
      }
      return startTrialConversion(grantId, sourceUrl, pending.current.idempotencyKey);
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.grant(grantId) });
      await onStarted(result.conversion.conversionId);
    },
  });
}

export async function exchangeCredential(grantId: string, credential: string): Promise<void> {
  const snapshot = grantSnapshotSchema.parse(
    await requestApi("none", (client) => client.exchangeCredential({ grantId }, { credential })),
  );

  const queryKey = QUERY_KEYS.grant(grantId);
  await queryClient.cancelQueries({ queryKey });
  queryClient.setQueryData(queryKey, snapshot);
  await queryClient.invalidateQueries({ queryKey });
}

async function startTrialConversion(
  grantId: string,
  sourceUrl: string,
  idempotencyKey: string,
): Promise<StartConversionResponse> {
  return startConversionResponseSchema.parse(
    await requestApi("none", (client) =>
      client.startTrialConversion({ grantId }, { sourceUrl }, idempotencyKey),
    ),
  );
}

async function getGrant(grantId: string, signal: AbortSignal): Promise<GrantSnapshot> {
  return grantSnapshotSchema.parse(
    await requestApi("none", (client) => client.getGrant({ grantId }, signal)),
  );
}
