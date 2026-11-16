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
