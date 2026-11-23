import { maskUrl } from "#src/url-masking.ts";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogEventSeverity = "error" | "warn" | "info" | "debug";

export type TelemetryLog = {
  level: LogLevel;
  message: string;
  attributes?: Record<string, unknown>;
};

export const LOG_EVENTS = {
  "content-limit": "warn",
  "narration-language-fallback": "warn",
  "narration-language-unspeakable": "warn",
  "cover-image-unavailable": "warn",
  "conversion-workflow-termination-failed": "warn",
  "conversion-dispatch-failed": "warn",
  "usage-projection-failed": "warn",
  "conversion-deletion-cleanup-failed": "warn",
  "account-deletion-identity-failed": "warn",
  "account-deletion-erasure-failed": "warn",
  "account-deletion-notice-undelivered": "warn",
  "narration-track-segment-mismatch": "error",
  "narration-document-mismatch": "error",
  "narration-document-render-failure": "error",
  "operator-mutation": "info",
  "conversion-preparation-settled": "info",
  "audio-segment-settled": "info",
  "conversion-synthesis-settled": "info",
} as const satisfies Record<string, LogEventSeverity>;

export type LogEventName = keyof typeof LOG_EVENTS;

export const LOG_ATTRIBUTES = {
  EVENT_NAME: "event.name",
  EXCEPTION_TYPE: "exception.type",
  EXCEPTION_MESSAGE: "exception.message",
  EXCEPTION_STACKTRACE: "exception.stacktrace",
} as const;

const SENT_LEVELS: ReadonlySet<LogLevel> = new Set(["info", "warn", "error", "fatal"]);

export function beforeSendLog(log: TelemetryLog): TelemetryLog | null {
  if (!SENT_LEVELS.has(log.level)) {
    return null;
  }
  const message = maskUrl(log.message);
  if (log.attributes === undefined) {
    return { ...log, message };
  }
  return {
    ...log,
    message,
    attributes: Object.fromEntries(
      Object.entries(log.attributes).map(([key, value]) => [
        key,
        typeof value === "string" ? maskUrl(value) : value,
      ]),
    ),
  };
}
