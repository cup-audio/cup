import { getIsolationScope, withIsolationScope } from "@sentry/core";

import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

/** What an entry point knows about the conversion it works on. */
export type ConversionTelemetryContext = {
  conversionId: string;
  /** The conversion owner, structurally `ConversionOwner` of `@cup/conversion-contracts`. */
  owner?: { kind: "account"; accountId: string } | { kind: "trial"; grantId: string };
  /** The audio segment, for a segment's synthesis. */
  sequence?: number;
};

/**
 * Puts the conversion's keys on Sentry's isolation scope of the current invocation: a Listener API
 * request, a Durable Object RPC call or a Workflow run. Sentry sends them as tags on errors and as
 * attributes on spans and logs. Without an active Sentry client it changes nothing that is sent.
 */
export function setConversionScope(context: ConversionTelemetryContext): void {
  const scope = getIsolationScope();
  for (const [key, value] of Object.entries(toConversionKeys(context))) {
    // Sentry's tags are strings; attributes keep the number's type.
    scope.setTag(key, String(value));
    scope.setAttribute(key, value);
  }
}

/**
 * Runs `callback` in a fork of the current isolation scope that carries the conversion's keys, for
 * one iteration of a Durable Object alarm that works through several conversions.
 */
export function withConversionScope<Result>(
  context: ConversionTelemetryContext,
  callback: () => Result,
): Result {
  return withIsolationScope(() => {
    setConversionScope(context);
    return callback();
  });
}

function toConversionKeys({
  conversionId,
  owner,
  sequence,
}: ConversionTelemetryContext): Record<string, string | number> {
  return {
    [TELEMETRY_ATTRIBUTES.CONVERSION_ID]: conversionId,
    ...(owner === undefined
      ? {}
      : owner.kind === "account"
        ? {
            [TELEMETRY_ATTRIBUTES.OWNER_KIND]: "account",
            [TELEMETRY_ATTRIBUTES.ACCOUNT_ID]: owner.accountId,
          }
        : {
            [TELEMETRY_ATTRIBUTES.OWNER_KIND]: "grant",
            [TELEMETRY_ATTRIBUTES.CONVERSION_GRANT_ID]: owner.grantId,
          }),
    ...(sequence === undefined ? {} : { [TELEMETRY_ATTRIBUTES.AUDIO_SEGMENT_SEQUENCE]: sequence }),
  };
}
