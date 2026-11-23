export const MASKED_QUERY_PARAMETERS = [
  "token",
  "key",
  "sig",
  "signature",
  "auth",
  "code",
  "access_token",
] as const;

export const MASKED_VALUE = "[Filtered]";

export type StreamedSpan = {
  name: string;
  attributes?: Record<string, unknown>;
};

type EventQueryString = string | [string, string][] | Record<string, string>;

export type MaskableBreadcrumb = { message?: string; data?: Record<string, unknown> };

export type MaskableEvent = {
  message?: string;
  request?: { url?: string; query_string?: EventQueryString };
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: MaskableBreadcrumb[];
};

const MASKED_PARAMETER_PATTERN = new RegExp(
  `(^|[?&;])(${MASKED_QUERY_PARAMETERS.join("|")})=[^&#\\s"']*`,
  "gi",
);

export function maskUrl(text: string): string {
  return text.replace(MASKED_PARAMETER_PATTERN, `$1$2=${MASKED_VALUE}`);
}

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
  const masked = entries.map(([name, value]): [string, string] => [
    name,
    maskUrl(`${name}=${value}`).slice(name.length + 1),
  ]);
  return Array.isArray(queryString) ? masked : Object.fromEntries(masked);
}
