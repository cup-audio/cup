import { z } from "zod";

import { createConversionArtifactPrefix } from "@cup/conversion-contracts";
import { CupError } from "@cup/errors";

const SOURCE_MATERIAL_CONTENT_TYPE = "text/html; charset=utf-8";

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

export type StoreSourceMaterialOptions = {
  artifactPrefix?: string;
  bucket: Pick<SourceMaterialStorage, "put">;
  conversionId: string;
  html: string;
};

export async function storeAudiobookSourceMaterial(
  options: StoreSourceMaterialOptions,
): Promise<void> {
  await storeSourceMaterial({ ...options, fileName: "audiobook-source-material.html" });
}

export async function storeNarrationSourceMaterial(
  options: StoreSourceMaterialOptions,
): Promise<NarrationSourceMaterialReference> {
  const storedObject = await storeSourceMaterial({
    ...options,
    fileName: "narration-source-material.html",
  });

  return {
    key: storedObject.key,
    contentType: SOURCE_MATERIAL_CONTENT_TYPE,
    byteLength: storedObject.size,
    etag: storedObject.etag,
  };
}

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

async function storeSourceMaterial({
  artifactPrefix,
  bucket,
  conversionId,
  html,
  fileName,
}: StoreSourceMaterialOptions & { fileName: string }): Promise<{
  key: string;
  size: number;
  etag: string;
}> {
  const key = `${artifactPrefix ?? createConversionArtifactPrefix(conversionId)}${fileName}`;
  const storedObject = await bucket.put(key, html, {
    httpMetadata: { contentType: SOURCE_MATERIAL_CONTENT_TYPE },
  });

  if (!storedObject) {
    throw new CupError(`Source material upload did not produce an object: ${key}`);
  }

  return storedObject;
}
