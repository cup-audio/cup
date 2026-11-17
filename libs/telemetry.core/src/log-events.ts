/*
 * Every log record Cup sends has a stable, kebab-case event name from this catalogue, and each
 * event has one fixed severity:
 *
 * - `error`: the operator must look at it;
 * - `warn`: degraded but handled;
 * - `info`: lifecycle events and outcomes;
 * - `debug`: never sent; `beforeSendLog` drops anything below `info`.
 *
 * Renaming an event breaks the operator's saved queries and alerts on it, so add a new name instead.
 */

import { maskUrl } from "#src/url-masking.ts";

/** Sentry's log levels, lowest first. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** The severities Cup's catalogue uses. */
export type LogEventSeverity = "error" | "warn" | "info" | "debug";

/** A log record as `beforeSendLog` receives it, before the SDK types its attributes. */
export type TelemetryLog = {
  level: LogLevel;
  message: string;
  attributes?: Record<string, unknown>;
};

/** Every log event Cup sends, by name, with its severity. */
export const LOG_EVENTS = {
  /** A preparation failed because the narration exceeds the conversion's content ceiling. */
  "content-limit": "warn",
  /** Narration language detection fell back to the declared language or to none. */
  "narration-language-fallback": "warn",
  /** The narration language is one the speech model cannot speak. */
  "narration-language-unspeakable": "warn",
  /** The declared cover image could not be stored; the audiobook goes without one. */
  "cover-image-unavailable": "warn",
  /** A deleted conversion's Workflow instance could not be terminated; it is tried once. */
  "conversion-workflow-termination-failed": "warn",
  /** One pass of a conversion's preparation dispatch failed; its owner's alarm retries it. */
  "conversion-dispatch-failed": "warn",
  /** The registry did not take an owner's usage projection; the owner's alarm pushes it again. */
  "usage-projection-failed": "warn",
  /** One pass of a marked conversion's cleanup failed; the account alarm retries it. */
  "conversion-deletion-cleanup-failed": "warn",
  /** One pass of an account deletion could not delete the Supabase identity; it is retried. */
  "account-deletion-identity-failed": "warn",
  /** One pass of an account deletion could not erase the account; it is retried. */
  "account-deletion-erasure-failed": "warn",
  /** An account deletion notice ended `failed` or `expired` without being delivered. */
  "account-deletion-notice-undelivered": "warn",
  /** A stored audio segment's size differs from the one its settled duration implies. */
  "narration-track-segment-mismatch": "error",
  /** The operator changed something through the Operator API. */
  "operator-mutation": "info",
  /**
   * The owner recorded a preparation outcome: `ready`, `failed` with its failure category, or
   * `insufficient-duration` for a prepared document that did not fit the available duration.
   */
  "conversion-preparation-settled": "info",
  /** The owner settled an audio segment's audio, or released its reservation after a failure. */
  "audio-segment-settled": "info",
  /** The last reserved audio segment of a conversion settled or was released. */
  "conversion-synthesis-settled": "info",
} as const satisfies Record<string, LogEventSeverity>;

export type LogEventName = keyof typeof LOG_EVENTS;

/** The attribute keys of a log record, by OpenTelemetry's semantic conventions where one exists. */
export const LOG_ATTRIBUTES = {
  EVENT_NAME: "event.name",
  /** The root cause of a logged error. */
  EXCEPTION_TYPE: "exception.type",
  /** Only for Cup's own errors. */
  EXCEPTION_MESSAGE: "exception.message",
  EXCEPTION_STACKTRACE: "exception.stacktrace",
} as const;

const SENT_LEVELS: ReadonlySet<LogLevel> = new Set(["info", "warn", "error", "fatal"]);

/**
 * The `beforeSendLog` hook of every runtime: drops anything below `info` and masks URLs in the
 * message and every string attribute.
 */
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
