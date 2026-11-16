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
  /** A Cloudflare Workflow instance ID, such as a segment's; a preparation's is its conversion ID. */
  WORKFLOW_INSTANCE_ID: "cup.workflow_instance.id",
  /** An account deletion's attempt ID; the account goes in `ACCOUNT_ID`. */
  ACCOUNT_DELETION_ATTEMPT_ID: "cup.account_deletion.attempt_id",
  /** Which account deletion notice: `scheduled` or `completed`. */
  ACCOUNT_DELETION_NOTICE_TYPE: "cup.account_deletion.notice_type",
  /** How a notice ended undelivered: `failed` or `expired`. */
  ACCOUNT_DELETION_NOTICE_STATE: "cup.account_deletion.notice_state",

  // Details of single log events; the catalogue in `log-events.ts` says which event uses which.
  NARRATION_TEXT_CHARACTERS: "cup.narration.text_characters",
  NARRATION_CHUNKS: "cup.narration.chunks",
  /** The page's `<html lang>`. */
  DECLARED_HTML_LANG: "cup.narration.declared_html_lang",
  /** The page's `og:locale`. */
  DECLARED_OG_LOCALE: "cup.narration.declared_og_locale",
  NARRATION_LANGUAGE: "cup.narration.language",
  NARRATION_LANGUAGE_FALLBACK_REASON: "cup.narration.language_fallback_reason",
  COVER_IMAGE_REFUSAL_REASON: "cup.cover_image.refusal_reason",
  AUDIO_SEGMENT_EXPECTED_BYTE_LENGTH: "cup.audio_segment.expected_byte_length",
  /** Absent when the segment is missing. */
  AUDIO_SEGMENT_STORED_BYTE_LENGTH: "cup.audio_segment.stored_byte_length",
} as const;

/**
 * The telemetry user of a listener who is not signed in, also after sign-out and account deletion.
 * Clients set it instead of `setUser(null)`, which would let a native SDK fill in its installation
 * ID.
 */
export const SIGNED_OUT_USER = { id: "signed-out" } as const;
