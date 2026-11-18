import { logger } from "@sentry/core";

import { describeExceptionChain } from "@cup/errors";
import {
  LOG_ATTRIBUTES,
  LOG_EVENTS,
  TELEMETRY_ATTRIBUTES,
  type LogEventName,
  type LogEventSeverity,
} from "@cup/telemetry.core";

/**
 * `Sentry.logger`'s function per severity. Indexing the `logger` namespace import directly fails
 * oxlint's `import/namespace` rule, which cannot check a computed member of a namespace.
 */
const LOG_FUNCTIONS = {
  error: logger.error,
  warn: logger.warn,
  info: logger.info,
  debug: logger.debug,
} satisfies Record<LogEventSeverity, typeof logger.info>;

/** A log attribute value Sentry types natively. */
export type LogAttributeValue = string | number | boolean | string[] | number[];

export type LogEventDetails = {
  /** The event's details, under `cup.*` keys or semantic-convention names; never an email. */
  attributes?: Record<string, LogAttributeValue | undefined>;
  /** A caught error: the record carries its root cause and `cup.exception.chain`. */
  error?: unknown;
};

/**
 * Sends one log record of the catalogue in `@cup/telemetry.core`, at the event's fixed severity,
 * through `Sentry.logger`. The record carries the event name as `event.name`, the prose `message`,
 * the given attributes and, for an `error`, its root cause as `exception.*` plus the wrapper types
 * as `cup.exception.chain`; only Cup's own errors keep their message. Without an active Sentry
 * client, as in local development and tests, it sends nothing.
 */
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
  // The SDK would send an `undefined` attribute as an empty string.
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
