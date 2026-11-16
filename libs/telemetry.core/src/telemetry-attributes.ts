/*
 * Cup's own telemetry keys, dot-namespaced under `cup.`. Each entry point puts the ones it knows on
 * Sentry's isolation scope once; Sentry sends them as tags on errors and as attributes on spans and
 * logs. Use a semantic-convention name instead where one exists.
 */

export const TELEMETRY_ATTRIBUTES = {
  /** The join key: every conversion-scoped error, span and log carries it. */
  CONVERSION_ID: "cup.conversion.id",
  AUDIO_SEGMENT_SEQUENCE: "cup.audio_segment.sequence",
  /** `account` or `grant`. */
  OWNER_KIND: "cup.owner.kind",
  ACCOUNT_ID: "cup.account.id",
  CONVERSION_GRANT_ID: "cup.conversion_grant.id",
  /** Which Worker entry point reported; `WorkerComponent` in `@cup/telemetry.cloudflare` lists them. */
  COMPONENT: "cup.component",
  CONVERSION_FAILURE_CATEGORY: "cup.conversion.failure_category",
  /** The wrapper types of a logged error, outermost to innermost. */
  EXCEPTION_CHAIN: "cup.exception.chain",
} as const;

/**
 * The telemetry user of a listener who is not signed in, also after sign-out and account deletion.
 * Clients set it instead of `setUser(null)`, which would let a native SDK fill in its installation
 * ID.
 */
export const SIGNED_OUT_USER = { id: "signed-out" } as const;
