import type { ErrorComponentProps } from "@tanstack/react-router";
import React from "react";

import { DSButton } from "#src/app/design-system/button.js";
import { useRetryRoute } from "#src/app/use-retry-route.js";
import { RpcError } from "#src/data-fetching/api-request.js";
import { useRateLimitCountdown } from "#src/data-fetching/rate-limit.js";

export function AccountLoading(): React.JSX.Element {
  return <output data-loading-state="">Loading account…</output>;
}

export function AccountLoadError({ error }: Pick<ErrorComponentProps, "error">): React.ReactNode {
  const retry = useRetryRoute();
  const retryIn = useRateLimitCountdown(error);

  if (!(error instanceof RpcError)) {
    return <p role="alert">{error instanceof Error ? error.message : String(error)}</p>;
  }

  return (
    <>
      <p role="alert">
        {error.status === 429
          ? "Too many new accounts from this connection. Your sign-in is retained; try again after the countdown."
          : "Account setup is still pending."}
      </p>
      {retryIn > 0 && <output>Try again in {retryIn} seconds.</output>}
      <DSButton disabled={retryIn > 0} onClick={retry}>
        Retry setup
      </DSButton>
    </>
  );
}
