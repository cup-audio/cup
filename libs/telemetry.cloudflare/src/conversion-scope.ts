import { getIsolationScope, withIsolationScope } from "@sentry/core";

import type { ConversionOwner } from "@cup/conversion-contracts";
import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

import { conversionOwnerKeys } from "#src/conversion-owner.ts";

export type ConversionTelemetryContext = {
  conversionId: string;
  owner?: ConversionOwner;
  sequence?: number;
};

export function setConversionScope(context: ConversionTelemetryContext): void {
  const scope = getIsolationScope();
  for (const [key, value] of Object.entries(toConversionKeys(context))) {
    scope.setTag(key, String(value));
    scope.setAttribute(key, value);
  }
}

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
    ...(owner === undefined ? {} : conversionOwnerKeys(owner)),
    ...(sequence === undefined ? {} : { [TELEMETRY_ATTRIBUTES.AUDIO_SEGMENT_SEQUENCE]: sequence }),
  };
}
