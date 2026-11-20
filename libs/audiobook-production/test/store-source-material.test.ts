import { expect, test } from "vitest";

import {
  loadNarrationSourceMaterial,
  storeAudiobookSourceMaterial,
  storeNarrationSourceMaterial,
  type SourceMaterialStorage,
} from "#src/index.ts";

const ARTIFACT_PREFIX = "accounts/account-id/conversions/conversion-id/";

test("stores the audiobook source material under the conversion prefix as HTML", async () => {
  const { bucket, storedObjects } = createTestBucket();

  await storeAudiobookSourceMaterial({
    artifactPrefix: ARTIFACT_PREFIX,
    bucket,
    conversionId: "conversion-id",
    html: "<main><p>Audiobook source material</p></main>",
  });

  expect(Object.fromEntries(storedObjects)).toEqual({
    "accounts/account-id/conversions/conversion-id/audiobook-source-material.html": {
      body: "<main><p>Audiobook source material</p></main>",
      contentType: "text/html; charset=utf-8",
    },
  });
});

test("stores the narration source material under the conversion prefix and returns its reference", async () => {
  const { bucket, storedObjects } = createTestBucket();

  const reference = await storeNarrationSourceMaterial({
    bucket,
    conversionId: "conversion-id",
    html: "<p>Narration source material – selected</p>",
  });

  expect(Object.fromEntries(storedObjects)).toEqual({
    "conversions/conversion-id/narration-source-material.html": {
      body: "<p>Narration source material – selected</p>",
      contentType: "text/html; charset=utf-8",
    },
  });
  expect(reference).toEqual({
    key: "conversions/conversion-id/narration-source-material.html",
    contentType: "text/html; charset=utf-8",
    byteLength: 45,
    etag: "etag-1",
  });
  await expect(loadNarrationSourceMaterial({ bucket, reference })).resolves.toBe(
    "<p>Narration source material – selected</p>",
  );
});

test("references the object storage kept when a repeated write is answered with an earlier one", async () => {
  const reference = await storeNarrationSourceMaterial({
    artifactPrefix: ARTIFACT_PREFIX,
    bucket: {
      put: async (key) => ({ key, size: 9000, etag: "earlier-etag" }),
    },
    conversionId: "conversion-id",
    html: "<p>Retried</p>",
  });

  expect(reference).toEqual({
    key: "accounts/account-id/conversions/conversion-id/narration-source-material.html",
    contentType: "text/html; charset=utf-8",
    byteLength: 9000,
    etag: "earlier-etag",
  });
});

test("fails loading narration source material that doesn't match its reference", async () => {
  const { bucket, storedObjects } = createTestBucket();
  const reference = await storeNarrationSourceMaterial({
    bucket,
    conversionId: "conversion-id",
    html: "<p>First attempt</p>",
  });

  await expect(
    loadNarrationSourceMaterial({ bucket, reference: { ...reference, etag: "other-etag" } }),
  ).rejects.toThrow(
    "Stored narration source material does not match its reference: conversions/conversion-id/narration-source-material.html",
  );
  await expect(
    loadNarrationSourceMaterial({ bucket, reference: { ...reference, byteLength: 1 } }),
  ).rejects.toThrow("does not match its reference");
  storedObjects.set(reference.key, { body: "<p>First attempt</p>", contentType: "text/plain" });
  await expect(loadNarrationSourceMaterial({ bucket, reference })).rejects.toThrow(
    "does not match its reference",
  );

  storedObjects.clear();
  await expect(loadNarrationSourceMaterial({ bucket, reference })).rejects.toThrow(
    "Narration source material was not found in storage: conversions/conversion-id/narration-source-material.html",
  );
});

test("fails when storage produces no object", async () => {
  const bucket: SourceMaterialStorage = { get: async () => null, put: async () => null };

  await expect(
    storeNarrationSourceMaterial({ bucket, conversionId: "conversion-id", html: "<p>x</p>" }),
  ).rejects.toThrow(
    "Source material upload did not produce an object: conversions/conversion-id/narration-source-material.html",
  );
  await expect(
    storeAudiobookSourceMaterial({ bucket, conversionId: "conversion-id", html: "<p>x</p>" }),
  ).rejects.toThrow(
    "Source material upload did not produce an object: conversions/conversion-id/audiobook-source-material.html",
  );
});

function createTestBucket(): {
  bucket: SourceMaterialStorage;
  storedObjects: Map<string, { body: string; contentType: string }>;
} {
  const storedObjects = new Map<string, { body: string; contentType: string }>();
  let writeCount = 0;
  const etags = new Map<string, string>();

  const bucket: SourceMaterialStorage = {
    get: async (key) => {
      const storedObject = storedObjects.get(key);

      return storedObject === undefined
        ? null
        : {
            size: new TextEncoder().encode(storedObject.body).byteLength,
            etag: etags.get(key)!,
            httpMetadata: { contentType: storedObject.contentType },
            text: async () => storedObject.body,
          };
    },
    put: async (key, value, { httpMetadata }) => {
      writeCount += 1;
      storedObjects.set(key, { body: value, contentType: httpMetadata.contentType });
      etags.set(key, `etag-${writeCount}`);

      return { key, size: new TextEncoder().encode(value).byteLength, etag: `etag-${writeCount}` };
    },
  };

  return { bucket, storedObjects };
}
