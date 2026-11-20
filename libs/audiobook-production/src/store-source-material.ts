import { z } from "zod";

import { createConversionArtifactPrefix } from "@cup/conversion-contracts";
import { CupError } from "@cup/errors";

const SOURCE_MATERIAL_CONTENT_TYPE = "text/html; charset=utf-8";

/** What a new conversion's manifest records about its stored narration source material. */
export const narrationSourceMaterialReferenceSchema = z
  .object({
    key: z.string().min(1),
    contentType: z.literal(SOURCE_MATERIAL_CONTENT_TYPE),
    byteLength: z.number().int().nonnegative().safe(),
    etag: z.string().min(1),
  })
  .strict();
export type NarrationSourceMaterialReference = z.infer<
  typeof narrationSourceMaterialReferenceSchema
>;

/** Minimal object-storage operations required to store and load source material. */
export type SourceMaterialStorage = {
  get(key: string): Promise<{
    size: number;
    etag: string;
    httpMetadata?: { contentType?: string };
    text(): Promise<string>;
  } | null>;
  put(
    key: string,
    value: string,
    options: { httpMetadata: { contentType: typeof SOURCE_MATERIAL_CONTENT_TYPE } },
  ): Promise<{ key: string; size: number; etag: string } | null>;
};

/** Supplies source material HTML and where to keep it. */
export type StoreSourceMaterialOptions = {
  artifactPrefix?: string;
  bucket: Pick<SourceMaterialStorage, "put">;
  conversionId: string;
  html: string;
};

/**
 * Keeps the audiobook source material, as source material preparation produced it, for possible
 * future evals. No manifest records it and nothing in the app reads it.
 */
export async function storeAudiobookSourceMaterial({
  artifactPrefix,
  bucket,
  conversionId,
  html,
}: StoreSourceMaterialOptions): Promise<void> {
  const key = `${artifactPrefix ?? createConversionArtifactPrefix(conversionId)}audiobook-source-material.html`;
  const storedObject = await bucket.put(key, html, {
    httpMetadata: { contentType: SOURCE_MATERIAL_CONTENT_TYPE },
  });

  if (!storedObject) {
    throw new CupError(`Audiobook source material upload did not produce an object: ${key}`);
  }
}

/**
 * Stores the narration source material exactly as narration content selection selected it, and
 * returns the reference the manifest records, through which alone it is read.
 */
export async function storeNarrationSourceMaterial({
  artifactPrefix,
  bucket,
  conversionId,
  html,
}: StoreSourceMaterialOptions): Promise<NarrationSourceMaterialReference> {
  const key = `${artifactPrefix ?? createConversionArtifactPrefix(conversionId)}narration-source-material.html`;
  const storedObject = await bucket.put(key, html, {
    httpMetadata: { contentType: SOURCE_MATERIAL_CONTENT_TYPE },
  });

  if (!storedObject) {
    throw new CupError(`Narration source material upload did not produce an object: ${key}`);
  }

  // The account artifact writer answers a repeated write with the object it already stored, so
  // the reference describes the stored object rather than the HTML offered in this attempt.
  return {
    key: storedObject.key,
    contentType: SOURCE_MATERIAL_CONTENT_TYPE,
    byteLength: storedObject.size,
    etag: storedObject.etag,
  };
}

/** Loads the narration source material a manifest references, and checks it is that object. */
export async function loadNarrationSourceMaterial({
  bucket,
  reference,
}: {
  bucket: Pick<SourceMaterialStorage, "get">;
  reference: NarrationSourceMaterialReference;
}): Promise<string> {
  const storedObject = await bucket.get(reference.key);

  if (!storedObject) {
    throw new CupError(`Narration source material was not found in storage: ${reference.key}`);
  }

  if (
    storedObject.httpMetadata?.contentType !== reference.contentType ||
    storedObject.size !== reference.byteLength ||
    storedObject.etag !== reference.etag
  ) {
    throw new CupError(
      `Stored narration source material does not match its reference: ${reference.key}`,
    );
  }

  return storedObject.text();
}
