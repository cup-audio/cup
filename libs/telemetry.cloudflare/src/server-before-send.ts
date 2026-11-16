import type { Breadcrumb, Contexts, ErrorEvent, EventHint, Exception } from "@sentry/core";

import { maskSpanUrls, maskUrl, type StreamedSpan } from "@cup/telemetry.core";

/*
 * Cup throws plain `Error`s with messages it writes itself, so those messages are safe to send. A
 * foreign error's message is not: Drizzle's `DrizzleQueryError` embeds the SQL parameters, and
 * Sentry's linked-errors integration sends every `cause` in the chain with its message. These are
 * the subclasses Cup defines in Worker code; a class missing here only loses its message.
 */
const CUP_ERROR_CLASS_NAMES = new Set([
  "AccountLifecycleConflictError",
  "ContentLimitError",
  "PermanentNarrationSynthesisError",
  "RateLimitedNarrationSynthesisError",
  "UnknownSelectionElementIdsError",
]);

/** Headers that carry the listener's IP address. */
const IP_HEADERS = new Set(["cf-connecting-ip", "true-client-ip", "x-forwarded-for", "x-real-ip"]);

/**
 * The SDK copies `request.cf.timezone` onto spans and, as the `culture` context, onto events: a
 * location finer than the country, which telemetry never keeps.
 */
const TIME_ZONE_ATTRIBUTE = "culture.timezone";

/**
 * The Worker's `beforeSend`: no IP address, no IP headers, no time zone, masked URLs, and only
 * Cup's own error messages. A foreign error in the captured chain keeps its class name as its type,
 * loses its message, and loses the properties `extraErrorDataIntegration` copied from it.
 */
export function beforeSendServerEvent(event: ErrorEvent, hint: EventHint): ErrorEvent {
  const chain = findErrorChain(hint.originalException);
  const sent: ErrorEvent = { ...event, user: { ...event.user, ip_address: null } };

  if (event.request !== undefined) {
    const { url, query_string: queryString, headers } = event.request;
    sent.request = {
      ...event.request,
      ...(url === undefined ? {} : { url: maskUrl(url) }),
      ...(queryString === undefined ? {} : { query_string: maskQueryString(queryString) }),
      ...(headers === undefined
        ? {}
        : {
            headers: Object.fromEntries(
              Object.entries(headers).filter(([name]) => !IP_HEADERS.has(name.toLowerCase())),
            ),
          }),
    };
  }

  if (event.breadcrumbs !== undefined) {
    sent.breadcrumbs = event.breadcrumbs.map(maskBreadcrumb);
  }

  if (event.exception?.values !== undefined) {
    const values = event.exception.values;
    sent.exception = {
      ...event.exception,
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
  const { cause: _cause, ...ownData } = extraData;
  return { ...otherContexts, [extraDataKey]: ownData };
}

/** The captured error and its causes, outermost first, in the order Sentry numbers them. */
function findErrorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let current = error; current instanceof Error && !chain.includes(current);) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function isCupError(error: Error): boolean {
  return error.constructor === Error || CUP_ERROR_CLASS_NAMES.has(error.constructor.name);
}

function scrubException(exception: Exception, error: Error | undefined): Exception {
  if (error === undefined || isCupError(error)) {
    return exception.value === undefined
      ? exception
      : { ...exception, value: maskUrl(exception.value) };
  }
  const { value: _value, ...withoutMessage } = exception;
  // A class that does not set `name`, such as `DrizzleQueryError`, would otherwise read as `Error`.
  return { ...withoutMessage, type: error.constructor.name };
}

function maskBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const url = breadcrumb.data?.["url"];
  return {
    ...breadcrumb,
    ...(breadcrumb.message === undefined ? {} : { message: maskUrl(breadcrumb.message) }),
    ...(typeof url === "string" ? { data: { ...breadcrumb.data, url: maskUrl(url) } } : {}),
  };
}

function maskQueryString(
  queryString: NonNullable<NonNullable<ErrorEvent["request"]>["query_string"]>,
): NonNullable<NonNullable<ErrorEvent["request"]>["query_string"]> {
  if (typeof queryString === "string") {
    return maskUrl(queryString);
  }
  const entries = Array.isArray(queryString) ? queryString : Object.entries(queryString);
  const masked = entries.map(([name, value]): [string, string] => [
    name,
    maskUrl(`${name}=${value}`).slice(name.length + 1),
  ]);
  return Array.isArray(queryString) ? masked : Object.fromEntries(masked);
}
