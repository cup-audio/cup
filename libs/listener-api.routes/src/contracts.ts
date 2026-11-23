import { z } from "zod";

import {
  accountDurationBalanceSchema,
  accountHistoryItemSchema,
  accountOutcomeSchema,
  accountSnapshotSchema as sharedAccountSnapshotSchema,
} from "@cup/accounts/contracts";
import {
  playbackPositionSchema as sharedPlaybackPositionSchema,
  durationBalanceSchema,
  sourceUrlSchema,
  insufficientDurationSchema,
} from "@cup/conversion-contracts";
import {
  grantConversionSnapshotSchema,
  grantConversionsSchema,
  grantSnapshotSchema as sharedGrantSnapshotSchema,
  type GrantConversionSnapshot,
  type GrantConversions,
  type GrantState,
} from "@cup/conversion-grants/contracts";
import { SYNCHRONIZATION_UNIT_SCHEMA } from "@cup/narration-document-creation";

const LOWERCASE_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CREDENTIAL_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;

export { sourceUrlSchema, grantConversionSnapshotSchema, grantConversionsSchema };
export type { GrantConversionSnapshot, GrantConversions, GrantState };

const durationBalanceResponseSchema = z.object(durationBalanceSchema.shape);
const accountDurationBalanceResponseSchema = z.object(accountDurationBalanceSchema.shape);
const synchronizationUnitResponseSchema = z.object(
  SYNCHRONIZATION_UNIT_SCHEMA.pick({ id: true, narrationText: true }).shape,
);
export const playbackPositionSchema = z.object(sharedPlaybackPositionSchema.shape);

export const grantSnapshotSchema = z.object({
  ...sharedGrantSnapshotSchema.shape,
  duration: durationBalanceResponseSchema,
});
export type GrantSnapshot = z.infer<typeof grantSnapshotSchema>;

export const uuidV4Schema = z
  .string()
  .regex(LOWERCASE_UUID_V4_PATTERN, "Must be a lowercase UUIDv4");

export const healthResponseSchema = z.object({ status: z.literal("ok") });

export const authConfigResponseSchema = z.object({
  supabaseUrl: z.string(),
  publishableKey: z.string().min(1),
  googleWebClientId: z.string().min(1).optional(),
  appleWebClientId: z.string().min(1).optional(),
  testAccount: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional(),
});

export const grantParamsSchema = z.object({ grantId: uuidV4Schema });
export type GrantParams = z.infer<typeof grantParamsSchema>;
export const conversionParamsSchema = z.object({ conversionId: uuidV4Schema });
export type ConversionParams = z.infer<typeof conversionParamsSchema>;

export const exchangeCredentialRequestSchema = z.object({
  credential: z.string().regex(CREDENTIAL_PATTERN),
});
export type ExchangeCredentialRequest = z.infer<typeof exchangeCredentialRequestSchema>;

export const startConversionRequestSchema = z.object({
  sourceUrl: sourceUrlSchema,
});
export type StartConversionRequest = z.infer<typeof startConversionRequestSchema>;

export const startConversionHeadersSchema = z
  .object({
    "content-type": z.literal("application/json"),
    "x-create-audiobook-from-url-request": z.literal("1"),
    "idempotency-key": uuidV4Schema,
  })
  .passthrough();
export const browserMutationHeadersSchema = z
  .object({
    "content-type": z.literal("application/json"),
    "x-create-audiobook-from-url-request": z.literal("1"),
  })
  .passthrough();
export const startConversionResponseSchema = z.object({
  result: z.enum(["created", "replayed"]),
  conversion: grantConversionSnapshotSchema,
  duration: durationBalanceResponseSchema,
});
export type StartConversionResponse = z.infer<typeof startConversionResponseSchema>;

export type { PlaybackPosition } from "@cup/conversion-contracts";
const audioSegmentBaseSchema = z.object({ sequence: z.number().int().nonnegative() });
export const audioSegmentSchema = z.discriminatedUnion("status", [
  audioSegmentBaseSchema.extend({ status: z.literal("absent") }),
  audioSegmentBaseSchema.extend({ status: z.literal("generating") }),
  audioSegmentBaseSchema.extend({ status: z.literal("ready") }),
  audioSegmentBaseSchema.extend({ status: z.literal("failed"), explanation: z.string() }),
]);
export type AudioSegment = z.infer<typeof audioSegmentSchema>;
export const signedMediaUrlQuerySchema = z.object({ token: z.string() });
export const signedPositionUrlQuerySchema = z.object({ token: z.string().optional() });
export const narrationTrackSchema = z.object({
  url: z.url(),
  positionUrl: z.url().optional(),
  durationMilliseconds: z.number().int().positive(),
  startMilliseconds: z.array(z.number().int().nonnegative()).min(1),
});
export type NarrationTrack = z.infer<typeof narrationTrackSchema>;
export const coverImageSchema = z.object({
  url: z.url(),
  alternativeText: z.string().min(1).optional(),
});
export type CoverImage = z.infer<typeof coverImageSchema>;
export const preparationPhaseSchema = z.enum([
  "starting",
  "reading-page",
  "selecting-content",
  "preparing-text",
]);
export type PreparationPhase = z.infer<typeof preparationPhaseSchema>;
const pendingPreparationPhaseSchema = z
  .preprocess(
    (value) =>
      typeof value === "string" && !preparationPhaseSchema.safeParse(value).success
        ? undefined
        : value,
    preparationPhaseSchema.optional(),
  )
  .optional();
const readerBase = { originalUrl: sourceUrlSchema, canGenerate: z.boolean() };
const narrationDocumentSchema = z.object({
  html: z.string().min(1),
  synchronizationUnits: z.array(synchronizationUnitResponseSchema).min(1),
});
export const audiobookQuerySchema = z.object({
  narrationDocument: z.enum(["include", "omit"]).optional(),
});
export type AudiobookQuery = z.infer<typeof audiobookQuerySchema>;

function createAudiobookSchema<NarrationDocument extends z.ZodType>(
  narrationDocument: NarrationDocument,
) {
  const preparedBase = {
    ...readerBase,
    title: z.string().min(1),
    coverImage: coverImageSchema.optional(),
    narrationDocument,
    segments: z.array(audioSegmentSchema),
    narrationTrack: narrationTrackSchema.optional(),
    playbackPosition: playbackPositionSchema.nullable(),
  };
  return z.discriminatedUnion("status", [
    z.object({
      ...readerBase,
      status: z.literal("pending"),
      preparationPhase: pendingPreparationPhaseSchema,
    }),
    z.object({ ...readerBase, status: z.literal("failed"), explanation: z.string() }),
    z.object({
      ...preparedBase,
      status: z.literal("insufficient-duration"),
      ...insufficientDurationSchema.shape,
    }),
    z.object({ ...preparedBase, status: z.literal("synthesizing") }),
    z.object({ ...preparedBase, status: z.literal("ready") }),
  ]);
}

export const audiobookSchema = createAudiobookSchema(narrationDocumentSchema);
export type Audiobook = z.infer<typeof audiobookSchema>;
export const audiobookResponseSchema = createAudiobookSchema(narrationDocumentSchema.optional());
export type AudiobookResponse = z.infer<typeof audiobookResponseSchema>;

export const retryConversionResponseSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("started") }),
  z.object({ result: z.literal("insufficient-duration"), ...insufficientDurationSchema.shape }),
]);
export type RetryConversionResponse = z.infer<typeof retryConversionResponseSchema>;

export const ERROR_CODE = {
  ACCOUNT_BLOCKED: "account-blocked",
  ACCOUNT_SESSION_REQUIRED: "account-session-required",
  ACCOUNT_SETUP_PENDING: "account-setup-pending",
  ACCOUNT_START_CONFLICT: "account-start-conflict",
  AUDIOBOOK_NOT_FOUND: "audiobook-not-found",
  CONFIRMATION_UNAVAILABLE: "confirmation-unavailable",
  COVER_IMAGE_NOT_FOUND: "cover-image-not-found",
  CREDITS_UNAVAILABLE: "credits-unavailable",
  DEPENDENCY_UNAVAILABLE: "dependency-unavailable",
  FRESH_AUTH_REQUIRED: "fresh-auth-required",
  GRANT_EXHAUSTED: "grant-exhausted",
  GRANT_EXPIRED: "grant-expired",
  GRANT_REVOKED: "grant-revoked",
  GRANT_SESSION_INVALID: "grant-session-invalid",
  GRANT_SESSION_REQUIRED: "grant-session-required",
  GRANT_TEMPORARILY_FULL: "grant-temporarily-full",
  IDEMPOTENCY_CONFLICT: "idempotency-conflict",
  INGRESS_UNAVAILABLE: "ingress-unavailable",
  INVALID_CREDENTIAL: "invalid-credential",
  INVALID_INPUT: "invalid-input",
  MEDIA_URL_INVALID: "media-url-invalid",
  METHOD_NOT_ALLOWED: "method-not-allowed",
  NARRATION_TRACK_NOT_FOUND: "narration-track-not-found",
  NOT_FOUND: "not-found",
  OPERATIONAL_ERROR: "operational-error",
  ORIGIN_BLOCKED: "origin-blocked",
  ORIGIN_FORBIDDEN: "origin-forbidden",
  POSITION_URL_INVALID: "position-url-invalid",
  RANGE_NOT_SATISFIABLE: "range-not-satisfiable",
  RATE_LIMITED: "rate-limited",
  REQUEST_TOO_LARGE: "request-too-large",
  START_RATE_LIMITED: "start-rate-limited",
  UNSUPPORTED_MEDIA_TYPE: "unsupported-media-type",
} as const;
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

const traceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, "Must be a 32-character lowercase hex trace ID");

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODE),
    message: z.string().min(1),
    traceId: traceIdSchema,
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const signInMethodSchema = z.enum(["google", "apple", "test-account"]);
export type SignInMethod = z.infer<typeof signInMethodSchema>;

export const providerCredentialSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("google"), accessToken: z.string().min(1).max(8192) }),
]);
export type ProviderCredential = z.infer<typeof providerCredentialSchema>;

export const accountConfirmationSchema = z.object({
  challengeId: z.uuidv4(),
  providerCredential: providerCredentialSchema.optional(),
});
export type AccountConfirmationRequest = z.infer<typeof accountConfirmationSchema>;

export const accountSnapshotSchema = z.object({
  ...sharedAccountSnapshotSchema.shape,
  balance: accountDurationBalanceResponseSchema,
});

export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;

const [readyAccountOutcomeSchema, failedAccountOutcomeSchema] = accountOutcomeSchema.options;
export const historyItemSchema = z.object({
  ...accountHistoryItemSchema.pick({
    conversionId: true,
    idempotencyKey: true,
    sourceUrl: true,
    createdAtMs: true,
    status: true,
  }).shape,
  preparationPhase: pendingPreparationPhaseSchema,
  outcome: z
    .discriminatedUnion("status", [
      z.object({
        ...readyAccountOutcomeSchema.pick({ status: true, title: true, hasCoverImage: true }).shape,
        coverImage: coverImageSchema.pick({ url: true }).optional(),
      }),
      z.object(failedAccountOutcomeSchema.pick({ status: true, explanation: true }).shape),
    ])
    .nullable(),
});
export type HistoryItem = z.infer<typeof historyItemSchema>;

export const accountStartResponseSchema = z.object({ conversionId: z.uuidv4() });

export const deletionChallengeSchema = z.object({
  challengeId: z.uuidv4(),
  subject: z.uuid(),
  issuedAtMs: z.number(),
  expiresAtMs: z.number(),
  acceptedMethods: z.array(signInMethodSchema).min(1),
});
export type DeletionChallenge = z.infer<typeof deletionChallengeSchema>;
export const scheduleDeletionResponseSchema = z.object({
  state: z.literal("deletion_scheduled"),
  recoveryDeadlineMs: z.number().optional(),
});
export type ScheduleDeletionResponse = z.infer<typeof scheduleDeletionResponseSchema>;
export const accountHistorySchema = z.object({
  items: z.array(historyItemSchema),
  nextCursor: z.string().nullable(),
});
export type AccountHistory = z.infer<typeof accountHistorySchema>;
