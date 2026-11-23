import { z } from "zod";

import { createConversionArtifactPrefix } from "@cup/conversion-contracts";
import { CupError } from "@cup/errors";
import { SYNCHRONIZATION_UNIT_SCHEMA } from "@cup/narration-document-creation";

import { AUDIOBOOK_MANIFEST_CONTENT_TYPE } from "#src/audio-format.ts";
import { isCanonicalLanguageTag } from "#src/language-tag.ts";
import {
  LEGACY_GEMINI_V4_SPEECH_CONFIG,
  SPEECH_CONFIG,
  type SpeechConfig,
} from "#src/speech-synthesis-config.ts";
import { coverImageSchema, type CoverImage } from "#src/store-cover-image.ts";
import { narrationSourceMaterialReferenceSchema } from "#src/store-source-material.ts";

const synchronizationUnitsSchema = z.array(SYNCHRONIZATION_UNIT_SCHEMA).min(1).readonly();

export const storedNarrationDocumentSchema = z.union([
  z
    .object({
      html: z.string().min(1),
      synchronizationUnits: synchronizationUnitsSchema,
    })
    .strict(),
  z
    .object({
      segmentationVersion: z.literal([1, 2]),
      narrationSourceMaterial: narrationSourceMaterialReferenceSchema,
      fetchedUrl: z.url().optional(),
      sourceSubtitle: z.string().min(1).optional(),
      synchronizationUnits: synchronizationUnitsSchema,
    })
    .strict(),
]);
export type StoredNarrationDocument = z.infer<typeof storedNarrationDocumentSchema>;

export type Audiobook = {
  title: string;
  originalUrl: string;
  narrationDocument: StoredNarrationDocument;
  speechConfig: SpeechConfig;
  narrationLanguage?: string | undefined;
  coverImage?: CoverImage | undefined;
};

export function countNarrationTextCharactersBySegment(narrationDocument: {
  synchronizationUnits: readonly { narrationText: string }[];
}): number[] {
  return narrationDocument.synchronizationUnits.map((unit) => unit.narrationText.length);
}

export type AudiobookReference = {
  key: string;
  contentType: typeof AUDIOBOOK_MANIFEST_CONTENT_TYPE;
  byteLength: number;
  etag: string;
};

export type ManifestStorage = {
  get(key: string): Promise<{
    key: string;
    size: number;
    etag: string;
    httpMetadata?: { contentType?: string };
    text(): Promise<string>;
  } | null>;
  put(
    key: string,
    value: string,
    options: { httpMetadata: { contentType: typeof AUDIOBOOK_MANIFEST_CONTENT_TYPE } },
  ): Promise<{ key: string; size: number; etag: string } | null>;
};

export type StoreOptions = {
  artifactPrefix?: string;
  bucket: ManifestStorage;
  conversionId: string;
  title: string;
  originalUrl: string;
  narrationDocument: StoredNarrationDocument;
  speechConfig?: SpeechConfig;
  narrationLanguage?: string;
  coverImage?: CoverImage;
};

export type LoadOptions = {
  bucket: ManifestStorage;
  audiobookReference: AudiobookReference;
};

export const audiobookSchema = z.object({
  title: z.string().min(1),
  originalUrl: z.url(),
  narrationDocument: storedNarrationDocumentSchema,
  speechConfig: z
    .object({
      provider: z.enum(["google-ai-studio", "elevenlabs"]),
      model: z.string().min(1),
      voice: z.string().min(1),
      policyVersion: z.string().min(1),
    })
    .default(LEGACY_GEMINI_V4_SPEECH_CONFIG),
  narrationLanguage: z
    .string()
    .refine(isCanonicalLanguageTag, "Expected a canonical BCP 47 language tag")
    .optional(),
  coverImage: coverImageSchema.optional(),
});

export async function storeAudiobook({
  artifactPrefix,
  bucket,
  conversionId,
  title,
  originalUrl,
  narrationDocument,
  speechConfig = SPEECH_CONFIG,
  narrationLanguage,
  coverImage,
}: StoreOptions): Promise<AudiobookReference> {
  const audiobook = audiobookSchema.parse({
    title,
    originalUrl,
    narrationDocument,
    speechConfig,
    narrationLanguage,
    coverImage,
  });
  const body = JSON.stringify(audiobook);
  const key = `${artifactPrefix ?? createConversionArtifactPrefix(conversionId)}audiobook.json`;
  const storedManifest = await bucket.put(key, body, {
    httpMetadata: { contentType: AUDIOBOOK_MANIFEST_CONTENT_TYPE },
  });

  if (!storedManifest) {
    throw new CupError(`Audiobook manifest upload did not produce an object: ${key}`);
  }

  return {
    key: storedManifest.key,
    contentType: AUDIOBOOK_MANIFEST_CONTENT_TYPE,
    byteLength: storedManifest.size,
    etag: storedManifest.etag,
  };
}

export async function loadAudiobook({
  bucket,
  audiobookReference,
}: LoadOptions): Promise<Audiobook> {
  const storedManifest = await bucket.get(audiobookReference.key);

  if (!storedManifest) {
    throw new CupError(`Audiobook manifest was not found in storage: ${audiobookReference.key}`);
  }

  if (
    storedManifest.httpMetadata?.contentType !== audiobookReference.contentType ||
    storedManifest.size !== audiobookReference.byteLength ||
    storedManifest.etag !== audiobookReference.etag
  ) {
    throw new CupError(
      `Stored audiobook manifest does not match its reference: ${audiobookReference.key}`,
    );
  }

  return audiobookSchema.parse(JSON.parse(await storedManifest.text()));
}
