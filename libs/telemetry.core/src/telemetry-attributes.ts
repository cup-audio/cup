/*
 * Cup's own telemetry keys, dot-namespaced under `cup.`. Each entry point puts the ones it knows on
 * Sentry's isolation scope once; Sentry sends them as tags on errors and as attributes on spans and
 * logs. Use a semantic-convention name instead where one exists.
 */

export const TELEMETRY_ATTRIBUTES = {
  /** The join key: every conversion-scoped error, span and log carries it. */
  CONVERSION_ID: "cup.conversion.id",
  AUDIO_SEGMENT_SEQUENCE: "cup.audio_segment.sequence",
  /** A synchronization unit's ID, such as the first one a rendered narration document got wrong. */
  SYNCHRONIZATION_UNIT_ID: "cup.synchronization_unit.id",
  /**
   * How a rendered narration document first disagreed with the stored units, one of the reasons
   * `NarrationDocumentMismatch` in `@cup/narration-document-creation` lists.
   */
  NARRATION_DOCUMENT_MISMATCH_REASON: "cup.narration_document.mismatch_reason",
  /** `account` or `grant`. */
  OWNER_KIND: "cup.owner.kind",
  ACCOUNT_ID: "cup.account.id",
  /** The Supabase subject of a sign-in identity; look it up in Supabase to see who it is. */
  IDENTITY_SUBJECT: "cup.identity.subject",
  /** `true` when a sign-in identity already has a Cup account, `false` for a first sign-in. */
  IDENTITY_HAS_ACCOUNT: "cup.identity.has_account",
  CONVERSION_GRANT_ID: "cup.conversion_grant.id",
  /** Which Worker entry point reported; `WorkerComponent` in `@cup/telemetry.cloudflare` lists them. */
  COMPONENT: "cup.component",
  CONVERSION_FAILURE_CATEGORY: "cup.conversion.failure_category",
  /** The conversion phase a conversion last started, such as `narration-content-selection`. */
  CONVERSION_PHASE: "cup.conversion.phase",
  /** A preparation outcome: `ready`, `failed` or `insufficient-duration`. */
  CONVERSION_OUTCOME: "cup.conversion.outcome",
  /** Milliseconds from the conversion's creation until the event, retries included. */
  CONVERSION_ELAPSED_MS: "cup.conversion.elapsed_ms",
  /** How many of a conversion's audio segments were released after a failure. */
  CONVERSION_FAILED_SEGMENTS: "cup.conversion.failed_segments",
  /** How an audio segment settled: `settled` with audio, or `released` after a failure. */
  AUDIO_SEGMENT_OUTCOME: "cup.audio_segment.outcome",
  /**
   * Milliseconds the segment held its duration reservation, until it settled or was released. More
   * than its synthesis took: it includes the wait for dispatch, retries and rate-limit waits.
   */
  AUDIO_SEGMENT_RESERVED_MS: "cup.audio_segment.reserved_ms",
  /** The synthesis attempts of the segment's Workflow run, rate-limited ones included. */
  AUDIO_SEGMENT_ATTEMPTS: "cup.audio_segment.attempts",
  /** `preparation` or `synthesis`: the stage a stuck conversion hangs in. */
  CONVERSION_STAGE: "cup.conversion.stage",
  /**
   * A shell's web bundle, `web@<content hash of the entry chunk>`: the shell's release names its
   * app version instead, so its JS and native events share one release.
   */
  WEB_RELEASE: "cup.web_release",
  /** Why a shell's Android WebView lost its renderer process: `crash` or `system-kill`. */
  RENDERER_CAUSE: "cup.renderer.cause",
  /**
   * The Android WebView renderer's priority when it ended: `waived`, `bound` or `important`, by
   * Android's `RenderProcessGoneDetail.rendererPriorityAtExit()`.
   */
  RENDERER_PRIORITY_AT_EXIT: "cup.renderer.priority_at_exit",
  /** Whether a shell was `foreground` or `background` when its WebView lost its page. */
  APP_STATE: "cup.app.state",
  /** The wrapper types of a logged error, outermost to innermost. */
  EXCEPTION_CHAIN: "cup.exception.chain",
  /** A Cloudflare Workflow instance ID, such as a segment's; a preparation's is its conversion ID. */
  WORKFLOW_INSTANCE_ID: "cup.workflow_instance.id",
  /** The account deletion attempt, an opaque ID distinct from the account ID. */
  ACCOUNT_DELETION_ATTEMPT_ID: "cup.account_deletion.attempt_id",
  /**
   * What an unfinished account deletion still waits for: `identity` (the Supabase identity),
   * `account` (the account's fence or erasure), or `both`.
   */
  ACCOUNT_DELETION_PENDING: "cup.account_deletion.pending",
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
 * The `cup.conversion.failure_category` of an audio segment's final failure. A failed preparation
 * is tagged with its conversion failure category instead.
 */
export const SEGMENT_FAILURE_CATEGORY = "segment";

/**
 * The telemetry user of a listener who is not signed in, also after sign-out and account deletion.
 * Clients set it instead of `setUser(null)`, which would let a native SDK fill in its installation
 * ID.
 */
export const SIGNED_OUT_USER = { id: "signed-out" } as const;
