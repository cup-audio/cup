import { z } from "zod";

import {
  conversionFailureCategorySchema,
  conversionPhaseSchema,
  type ConversionPhase,
} from "@cup/conversion-contracts";

export const accountIdentitySchema = z
  .object({
    accountId: z.uuidv4(),
    subject: z.uuid(),
    createdAtMs: z.number().int().nonnegative().safe(),
  })
  .strict();

export type AccountIdentity = z.infer<typeof accountIdentitySchema>;

export const accountDurationBalanceSchema = z
  .object({
    unit: z.literal("audio-millisecond"),
    available: z.number().int().nonnegative().safe(),
    reserved: z.number().int().nonnegative().safe(),
  })
  .strict();
export type AccountDurationBalance = z.infer<typeof accountDurationBalanceSchema>;

export const accountSnapshotSchema = accountIdentitySchema
  .extend({
    state: z.enum(["active", "deletion_scheduled", "deleting"]),
    executionEpoch: z.number().int().positive(),
    recoveryDeadlineMs: z.number().nullable(),
    balance: accountDurationBalanceSchema,
  })
  .strict();
export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;

export const accountAccountingInspectionSchema = z
  .object({
    balance: accountDurationBalanceSchema,
    reconstructed: z.object({ available: z.number(), reserved: z.number() }).strict(),
    entries: z.number().int().nonnegative(),
  })
  .strict();
export type AccountAccountingInspection = z.infer<typeof accountAccountingInspectionSchema>;

export const accountLedgerEntrySchema = z
  .object({
    eventKind: z.enum(["grant", "reserve", "consume", "release", "adjustment"]),
    operationId: z.string(),
    amount: z.number().int().nonnegative().safe(),
    availableDelta: z.number().int().safe(),
    reservedDelta: z.number().int().safe(),
    createdAtMs: z.number().int().nonnegative().safe(),
    cause: z.string(),
  })
  .strict();
export type AccountLedgerEntry = z.infer<typeof accountLedgerEntrySchema>;

export const accountLedgerPageSchema = z
  .object({
    unit: z.literal("audio-millisecond"),
    entries: z.array(accountLedgerEntrySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type AccountLedgerPage = z.infer<typeof accountLedgerPageSchema>;

export const accountArtifactWriterSchema = z
  .object({
    writerId: z.string(),
    prefix: z.string(),
    state: z.enum(["running", "drained", "uncertain"]),
    effect: z.string().nullable(),
  })
  .strict();
export type AccountArtifactWriter = z.infer<typeof accountArtifactWriterSchema>;

export const accountConversionDeletionSchema = z
  .object({
    conversionId: z.string(),
    deletingSinceMs: z.number().int().nonnegative().safe(),
  })
  .strict();
export type AccountConversionDeletion = z.infer<typeof accountConversionDeletionSchema>;

export const ACCOUNT_USAGE_PROJECTION_SCHEMA_VERSION = 1;

export const accountUsageProjectionSchema = z
  .object({
    accountId: z.uuidv4(),
    revision: z.number().int().positive().safe(),
    allowanceMilliseconds: z.number().int().nonnegative().safe(),
    reservedMilliseconds: z.number().int().nonnegative().safe(),
    spentMilliseconds: z.number().int().nonnegative().safe(),
    schemaVersion: z.number().int().positive().safe(),
  })
  .strict();

export type AccountUsageProjection = z.infer<typeof accountUsageProjectionSchema>;

export type AccountConversion = {
  conversionId: string;
  idempotencyKey: string;
  sourceUrl: string;
  createdAtMs: number;
  status: "pending" | "ready" | "failed";
  lastStartedPhase: ConversionPhase;
};

export const startAccountConversionSchema = z
  .object({
    idempotencyKey: z.uuidv4(),
    sourceUrl: z
      .string()
      .max(2048)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
      }, "Source URL must use HTTP or HTTPS without credentials"),
  })
  .strict();

export const accountOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      title: z.string().min(1),
      audiobookReference: z
        .object({
          key: z.string().min(1),
          contentType: z.literal("application/json"),
          byteLength: z.number().int().positive().safe(),
          etag: z.string().min(1),
        })
        .strict(),
      hasCoverImage: z.literal(true).optional(),
      narrationLanguage: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      failureCategory: z.preprocess(
        (category) => (category === "execution-failed" ? "workflow-platform" : category),
        conversionFailureCategorySchema,
      ),
      explanation: z.string().min(1),
    })
    .strict(),
]);
export type AccountConversionOutcome = z.infer<typeof accountOutcomeSchema>;

export const accountHistoryItemSchema = z
  .object({
    conversionId: z.uuid(),
    idempotencyKey: z.uuid(),
    sourceUrl: z.string(),
    createdAtMs: z.number(),
    status: z.enum(["pending", "insufficient-duration", "synthesizing", "ready", "failed"]),
    lastStartedPhase: conversionPhaseSchema,
    outcome: accountOutcomeSchema.nullable(),
    completedAtMs: z.number().nullable(),
  })
  .strict();
export type AccountHistoryItem = z.infer<typeof accountHistoryItemSchema>;

export const accountHistoryPageSchema = z
  .object({ items: z.array(accountHistoryItemSchema), nextCursor: z.string().nullable() })
  .strict();
export type AccountHistoryPage = z.infer<typeof accountHistoryPageSchema>;

export type AccountWorkflowParams = {
  v: 2;
  sourceUrl: string;
  owner: { kind: "account"; accountId: string };
  conversionId: string;
  executionEpoch: number;
};
