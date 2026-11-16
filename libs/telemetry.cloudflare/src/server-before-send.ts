import type { Contexts, ErrorEvent, EventHint, Exception } from "@sentry/core";

import { findErrorChain, findErrorType, isCupError } from "@cup/errors";
import { maskEventUrls, maskSpanUrls, type StreamedSpan } from "@cup/telemetry.core";

/** Headers that carry the listener's IP address. */
const IP_HEADERS = new Set(["cf-connecting-ip", "true-client-ip", "x-forwarded-for", "x-real-ip"]);

/**
 * The SDK copies `request.cf.timezone` onto spans and, as the `culture` context, onto events: a
 * location finer than the country, which telemetry never keeps.
 */
const TIME_ZONE_ATTRIBUTE = "culture.timezone";

/**
 * The mechanisms of the captures Sentry's wrappers make on their own, which Cup's capture rule
 * leaves out. The Workflow wrapper captures a step's last failed attempt, though the run goes on
 * and Cup captures only the instance's final failure. The Durable Object wrapper captures every
 * error an RPC method or the alarm throws, though the caller captures an RPC error at its boundary,
 * and the alarm captures its own failure with `captureAlarmFailure`.
 */
const DROPPED_MECHANISMS = new Set([
  "auto.faas.cloudflare.workflow",
  "auto.faas.cloudflare.durable_object",
]);

/** Whether a capture's mechanism is that of one of Sentry's wrappers, which Cup's rule leaves out. */
export function isWrapperCapture(mechanismType: string | undefined): boolean {
  return DROPPED_MECHANISMS.has(mechanismType ?? "");
}

/**
 * The Worker's `beforeSend`: drops the wrappers' own captures, then sends no IP address, no IP
 * headers, no time zone, masked URLs, and only Cup's own error messages. A foreign error in the
 * captured chain keeps its class name as its type, loses its message, and loses the properties
 * `extraErrorDataIntegration` copied from it.
 */
export function beforeSendServerEvent(event: ErrorEvent, hint: EventHint): ErrorEvent | null {
  if (event.exception?.values?.some((value) => isWrapperCapture(value.mechanism?.type))) {
    return null;
  }

  const chain = findErrorChain(hint.originalException);
  const masked = maskEventUrls(event);
  const sent: ErrorEvent = { ...masked, user: { ...event.user, ip_address: null } };

  const headers = masked.request?.headers;
  if (masked.request !== undefined && headers !== undefined) {
    sent.request = {
      ...masked.request,
      headers: Object.fromEntries(
        Object.entries(headers).filter(([name]) => !IP_HEADERS.has(name.toLowerCase())),
      ),
    };
  }

  if (masked.exception?.values !== undefined) {
    const values = masked.exception.values;
    sent.exception = {
      ...masked.exception,
      values: values.map((value, index) =>
        scrubException(value, chain[value.mechanism?.exception_id ?? values.length - 1 - index]),
      ),
    };
  }

  if (event.contexts !== undefined) {
    sent.contexts = scrubContexts(event.contexts, chain[0]);
  }

  return sent;
}

/** The Worker's `beforeSendSpan`: masked URLs and no time zone. */
export function beforeSendServerSpan<Span extends StreamedSpan>(span: Span): Span {
  if (span.attributes === undefined) {
    return maskSpanUrls(span);
  }
  const { [TIME_ZONE_ATTRIBUTE]: _timeZone, ...attributes } = span.attributes;
  return maskSpanUrls({ ...span, attributes });
}

/**
 * Drops the `culture` context and the extra data of the captured error that is not Cup's to send:
 * all of it for a foreign error, and the copy of the next error in the chain for Cup's own.
 */
function scrubContexts(contexts: Contexts, mainError: Error | undefined): Contexts {
  const { culture: _culture, ...scrubbed } = contexts;
  if (mainError === undefined) {
    return scrubbed;
  }

  // `extraErrorDataIntegration` files the data under the error's name.
  const extraDataKey = mainError.name || mainError.constructor.name;
  const extraData = scrubbed[extraDataKey];
  if (extraData === undefined) {
    return scrubbed;
  }
  const { [extraDataKey]: _extraData, ...otherContexts } = scrubbed;
  if (!isCupError(mainError)) {
    return otherContexts;
  }
  // The brand of a Cup error says nothing about the failure.
  const { cause: _cause, cupError: _cupError, ...ownData } = extraData;
  return Object.keys(ownData).length === 0
    ? otherContexts
    : { ...otherContexts, [extraDataKey]: ownData };
}

function scrubException(exception: Exception, error: Error | undefined): Exception {
  if (error === undefined || isCupError(error)) {
    return exception;
  }
  const { value: _value, ...withoutMessage } = exception;
  return { ...withoutMessage, type: findErrorType(error) };
}
