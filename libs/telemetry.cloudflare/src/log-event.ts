import { logger } from "@sentry/core";

import { describeExceptionChain } from "@cup/errors";
import {
  LOG_ATTRIBUTES,
  LOG_EVENTS,
  TELEMETRY_ATTRIBUTES,
  type LogEventName,
  type LogEventSeverity,
} from "@cup/telemetry.core";

const LOG_FUNCTIONS = {
  error: logger.error,
  warn: logger.warn,
  info: logger.info,
  debug: logger.debug,
} satisfies Record<LogEventSeverity, typeof logger.info>;

export type LogAttributeValue = string | number | boolean | string[] | number[];

export type LogEventDetails = {
  attributes?: Record<string, LogAttributeValue | undefined>;
  error?: unknown;
};

export function logEvent(
  event: LogEventName,
  message: string,
  { attributes = {}, error }: LogEventDetails = {},
): void {
  const exceptionAttributes = error === undefined ? {} : describeError(error);
  const allAttributes = {
    ...attributes,
    ...exceptionAttributes,
    [LOG_ATTRIBUTES.EVENT_NAME]: event,
  };
  LOG_FUNCTIONS[LOG_EVENTS[event]](
    message,
    Object.fromEntries(Object.entries(allAttributes).filter(([, value]) => value !== undefined)),
  );
}

function describeError(error: unknown): Record<string, LogAttributeValue | undefined> {
  const { rootCause, wrapperTypes } = describeExceptionChain(error);
  return {
    [LOG_ATTRIBUTES.EXCEPTION_TYPE]: rootCause.type,
    [LOG_ATTRIBUTES.EXCEPTION_MESSAGE]: rootCause.message,
    [LOG_ATTRIBUTES.EXCEPTION_STACKTRACE]: rootCause.stacktrace,
    [TELEMETRY_ATTRIBUTES.EXCEPTION_CHAIN]: wrapperTypes,
  };
}
