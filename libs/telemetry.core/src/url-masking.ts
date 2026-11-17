/*
 * Signed media URLs carry their credential in `token`, and OAuth callbacks carry `code` and
 * `access_token`: a URL that reaches telemetry with one of these could be replayed. Every privacy
 * hook (`beforeSend`, `beforeSendSpan`, `beforeSendLog`, `beforeBreadcrumb`) masks them with this
 * one function and keeps the rest of the URL, so the source URL stays readable.
 */

/** The query parameter names whose values never reach telemetry. */
export const MASKED_QUERY_PARAMETERS = [
  "token",
  "key",
  "sig",
  "signature",
  "auth",
  "code",
  "access_token",
] as const;

/** What a masked value becomes; Sentry's own scrubbers use the same marker. */
export const MASKED_VALUE = "[Filtered]";

/** A span as `beforeSendSpan` receives it under `traceLifecycle: "stream"`. */
export type StreamedSpan = {
  name: string;
  attributes?: Record<string, unknown>;
};

/** A request's query string as an event carries it: raw, as entries, or as a record. */
type EventQueryString = string | [string, string][] | Record<string, string>;

/** A breadcrumb as `beforeBreadcrumb` and `beforeSend` receive it. */
export type MaskableBreadcrumb = { message?: string; data?: Record<string, unknown> };

/** The parts of an error event that can hold URLs. */
export type MaskableEvent = {
  message?: string;
  request?: { url?: string; query_string?: EventQueryString };
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: MaskableBreadcrumb[];
};

/*
 * A parameter starts the text or follows `?`, `&` or `;`, so `monkey=` never matches `key=`. The
 * value ends at the next parameter, fragment, whitespace or quote.
 */
const MASKED_PARAMETER_PATTERN = new RegExp(
  `(^|[?&;])(${MASKED_QUERY_PARAMETERS.join("|")})=[^&#\\s"']*`,
  "gi",
);

/**
 * Masks the values of {@link MASKED_QUERY_PARAMETERS} in a URL, a bare query string, or text that
 * contains URLs, such as an error message.
 */
export function maskUrl(text: string): string {
  return text.replace(MASKED_PARAMETER_PATTERN, `$1$2=${MASKED_VALUE}`);
}

/** The `beforeSendSpan` hook of every runtime: masks URLs in the span name and its attributes. */
export function maskSpanUrls<Span extends StreamedSpan>(span: Span): Span {
  if (span.attributes === undefined) {
    return { ...span, name: maskUrl(span.name) };
  }
  return {
    ...span,
    name: maskUrl(span.name),
    attributes: Object.fromEntries(
      Object.entries(span.attributes).map(([key, value]) => [key, maskAttributeValue(value)]),
    ),
  };
}

/** An attribute is a raw value or, once typed, `{ value, type }`. */
function maskAttributeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return maskUrl(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => maskAttributeValue(entry));
  }
  if (typeof value === "object" && value !== null && "value" in value) {
    return { ...value, value: maskAttributeValue(value.value) };
  }
  return value;
}

/**
 * The URL masking of every runtime's `beforeSend`: masks URLs in the event's message, its request's
 * URL and query string, its exception values and its breadcrumbs.
 */
export function maskEventUrls<Event extends MaskableEvent>(event: Event): Event {
  const { message, request, exception, breadcrumbs } = event;
  return {
    ...event,
    ...(message === undefined ? {} : { message: maskUrl(message) }),
    ...(request === undefined
      ? {}
      : {
          request: {
            ...request,
            ...(request.url === undefined ? {} : { url: maskUrl(request.url) }),
            ...(request.query_string === undefined
              ? {}
              : { query_string: maskQueryString(request.query_string) }),
          },
        }),
    ...(exception?.values === undefined
      ? {}
      : {
          exception: {
            ...exception,
            values: exception.values.map((value) =>
              value.value === undefined ? value : { ...value, value: maskUrl(value.value) },
            ),
          },
        }),
    ...(breadcrumbs === undefined ? {} : { breadcrumbs: breadcrumbs.map(maskBreadcrumbUrls) }),
  };
}

/**
 * The URL masking of every runtime's breadcrumbs: masks URLs in the message and in every string of
 * the data, such as a request's `url` or a navigation's `from` and `to`.
 */
export function maskBreadcrumbUrls<Breadcrumb extends MaskableBreadcrumb>(
  breadcrumb: Breadcrumb,
): Breadcrumb {
  const { message, data } = breadcrumb;
  return {
    ...breadcrumb,
    ...(message === undefined ? {} : { message: maskUrl(message) }),
    ...(data === undefined
      ? {}
      : {
          data: Object.fromEntries(
            Object.entries(data).map(([key, value]) => [
              key,
              typeof value === "string" ? maskUrl(value) : value,
            ]),
          ),
        }),
  };
}

function maskQueryString(queryString: EventQueryString): EventQueryString {
  if (typeof queryString === "string") {
    return maskUrl(queryString);
  }
  const entries = Array.isArray(queryString) ? queryString : Object.entries(queryString);
  // Masking `name=value` keeps the rule that decides by the parameter's name in one place.
  const masked = entries.map(([name, value]): [string, string] => [
    name,
    maskUrl(`${name}=${value}`).slice(name.length + 1),
  ]);
  return Array.isArray(queryString) ? masked : Object.fromEntries(masked);
}
