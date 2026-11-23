import { z } from "zod";

import { createConversionArtifactPrefix } from "@cup/conversion-contracts";
import { CupError } from "@cup/errors";

const COVER_IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
] as const;
export type CoverImageContentType = (typeof COVER_IMAGE_CONTENT_TYPES)[number];

export const coverImageSchema = z
  .object({
    contentType: z.enum(COVER_IMAGE_CONTENT_TYPES),
    byteLength: z.number().int().positive().safe(),
    alternativeText: z.string().min(1).optional(),
  })
  .strict();
export type CoverImage = z.infer<typeof coverImageSchema>;

export type CoverImageStorage = {
  put(
    key: string,
    value: Uint8Array,
    options: { httpMetadata: { contentType: CoverImageContentType } },
  ): Promise<{ size: number; httpMetadata?: { contentType?: string } } | null>;
};

export type StoreCoverImageOptions = {
  alternativeText?: string;
  artifactPrefix?: string;
  bucket: CoverImageStorage;
  bytes: Uint8Array;
  contentType: CoverImageContentType;
  conversionId: string;
};

export function createCoverImageKey(conversionId: string, artifactPrefix?: string): string {
  return `${artifactPrefix ?? createConversionArtifactPrefix(conversionId)}cover-image`;
}

export async function storeCoverImage({
  alternativeText,
  artifactPrefix,
  bucket,
  bytes,
  contentType,
  conversionId,
}: StoreCoverImageOptions): Promise<CoverImage> {
  const key = createCoverImageKey(conversionId, artifactPrefix);
  const storedImage = await bucket.put(key, bytes, { httpMetadata: { contentType } });

  if (!storedImage) {
    throw new CupError(`Cover image upload did not produce an object: ${key}`);
  }

  return coverImageSchema.parse({
    contentType: storedImage.httpMetadata?.contentType,
    byteLength: storedImage.size,
    ...(alternativeText === undefined ? {} : { alternativeText }),
  });
}
