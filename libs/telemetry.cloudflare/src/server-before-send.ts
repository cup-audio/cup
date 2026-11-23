import type { Contexts, ErrorEvent, EventHint, Exception } from "@sentry/core";

import { findErrorChain, findErrorType, isCupError } from "@cup/errors";
import { maskEventUrls, maskSpanUrls, type StreamedSpan } from "@cup/telemetry.core";

import { CLIENT_IP_HEADERS } from "#src/client-ip-headers.ts";

const IP_HEADERS = new Set(CLIENT_IP_HEADERS);

const TIME_ZONE_ATTRIBUTE = "culture.timezone";

const DROPPED_MECHANISMS = new Set([
  "auto.faas.cloudflare.workflow",
  "auto.faas.cloudflare.durable_object",
]);

export function isWrapperCapture(mechanismType: string | undefined): boolean {
  return DROPPED_MECHANISMS.has(mechanismType ?? "");
}

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

export function beforeSendServerSpan<Span extends StreamedSpan>(span: Span): Span {
  if (span.attributes === undefined) {
    return maskSpanUrls(span);
  }
  const { [TIME_ZONE_ATTRIBUTE]: _timeZone, ...attributes } = span.attributes;
  return maskSpanUrls({ ...span, attributes });
}

function scrubContexts(contexts: Contexts, mainError: Error | undefined): Contexts {
  const { culture: _culture, ...scrubbed } = contexts;
  if (mainError === undefined) {
    return scrubbed;
  }

  const extraDataKey = mainError.name || mainError.constructor.name;
  const extraData = scrubbed[extraDataKey];
  if (extraData === undefined) {
    return scrubbed;
  }
  const { [extraDataKey]: _extraData, ...otherContexts } = scrubbed;
  if (!isCupError(mainError)) {
    return otherContexts;
  }
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
