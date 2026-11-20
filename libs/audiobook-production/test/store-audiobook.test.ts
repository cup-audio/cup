import { expect, test } from "vitest";
import { z } from "zod";

import {
  loadAudiobook,
  storeAudiobook,
  SPEECH_CONFIG,
  type StoredNarrationDocument,
  type StoreOptions,
} from "#src/index.ts";

const document = {
  html: '<h1 id="unit-1">Title</h1><p id="unit-2">Body</p>',
  synchronizationUnits: [
    { id: "unit-1", narrationText: "Title" },
    { id: "unit-2", narrationText: "Body" },
  ],
};
test("publishes prepared narration without requiring any audio and fixes the speech configuration", async () => {
  const { bucket, storedObjects } = createTestBucket();
  const reference = await storeAudiobook({
    bucket,
    conversionId: "conversion-id",
    title: "Title",
    originalUrl: "https://example.com",
    narrationDocument: document,
  });
  expect([...storedObjects.keys()]).toEqual(["conversions/conversion-id/audiobook.json"]);
  const audiobook = await loadAudiobook({ bucket, audiobookReference: reference });
  expect(audiobook).toEqual({
    title: "Title",
    originalUrl: "https://example.com",
    narrationDocument: document,
    speechConfig: SPEECH_CONFIG,
  });
  expect(audiobook).not.toHaveProperty("audio");
});
test("records the stored cover image in the manifest", async () => {
  const { bucket } = createTestBucket();
  const coverImage = {
    contentType: "image/jpeg",
    byteLength: 2048,
    alternativeText: "A lighthouse at dusk",
  } as const;
  const reference = await storeAudiobook({
    bucket,
    conversionId: "conversion-id",
    title: "Title",
    originalUrl: "https://example.com",
    narrationDocument: document,
    coverImage,
  });

  await expect(loadAudiobook({ bucket, audiobookReference: reference })).resolves.toMatchObject({
    coverImage,
  });
});
test("records the narration language in the manifest, outside the speech configuration", async () => {
  const { bucket } = createTestBucket();
  const reference = await storeAudiobook({
    bucket,
    conversionId: "conversion-id",
    title: "Title",
    originalUrl: "https://example.com",
    narrationDocument: document,
    narrationLanguage: "de-AT",
  });

  await expect(loadAudiobook({ bucket, audiobookReference: reference })).resolves.toMatchObject({
    narrationLanguage: "de-AT",
    speechConfig: SPEECH_CONFIG,
  });
});
test.each(["de_AT", "de-at", "not a tag"])(
  "rejects the non-canonical narration language %s before publishing",
  async (narrationLanguage) => {
    const { bucket, storedObjects } = createTestBucket();
    await expect(
      storeAudiobook({
        bucket,
        conversionId: "conversion-id",
        title: "Title",
        originalUrl: "https://example.com",
        narrationDocument: document,
        narrationLanguage,
      }),
    ).rejects.toThrow("Expected a canonical BCP 47 language tag");
    expect(storedObjects.size).toBe(0);
  },
);
test("loads a manifest from before speechConfig with the policy 4 Gemini configuration", async () => {
  const { bucket, storedObjects } = createTestBucket();
  const reference = await storeAudiobook({
    bucket,
    conversionId: "conversion-id",
    title: "Title",
    originalUrl: "https://example.com",
    narrationDocument: document,
  });
  const key = "conversions/conversion-id/audiobook.json";
  const storedManifest = storedObjects.get(key);
  if (!storedManifest) {
    throw new Error("Expected a stored manifest");
  }
  const { speechConfig: _, ...manifestWithoutSpeechConfig } = z
    .looseObject({ speechConfig: z.unknown() })
    .parse(JSON.parse(storedManifest.body));
  const body = JSON.stringify(manifestWithoutSpeechConfig);
  storedObjects.set(key, { ...storedManifest, body });

  const audiobook = await loadAudiobook({
    bucket,
    audiobookReference: { ...reference, byteLength: new TextEncoder().encode(body).byteLength },
  });

  expect(audiobook.speechConfig).toEqual({
    provider: "google-ai-studio",
    model: "gemini-3.8-flash-lite-tts",
    voice: "Charon",
    policyVersion: "4",
  });
});
test("stores and loads a new conversion's manifest, which references its narration source material instead of holding HTML", async () => {
  const { bucket, storedObjects } = createTestBucket();
  const narrationDocument = {
    segmentationVersion: 1,
    narrationSourceMaterial: {
      key: "conversions/conversion-id/narration-source-material.html",
      contentType: "text/html; charset=utf-8",
      byteLength: 42,
      etag: "narration-source-material-etag",
    },
    fetchedUrl: "https://www.example.com/story",
    sourceSubtitle: "Subtitle",
    synchronizationUnits: [
      { id: "unit-1", narrationText: "Title" },
      { id: "unit-2", narrationText: "Subtitle" },
      { id: "unit-3", narrationText: "Body" },
    ],
  } satisfies StoredNarrationDocument;

  const reference = await storeAudiobook({
    bucket,
    conversionId: "conversion-id",
    title: "Title",
    originalUrl: "https://example.com/story",
    narrationDocument,
  });

  expect(JSON.parse(storedObjects.get(reference.key)!.body)).not.toHaveProperty(
    "narrationDocument.html",
  );
  await expect(loadAudiobook({ bucket, audiobookReference: reference })).resolves.toEqual({
    title: "Title",
    originalUrl: "https://example.com/story",
    narrationDocument,
    speechConfig: SPEECH_CONFIG,
  });
});
test("loads a manifest whose units speech policy 7 marked as continuing a narration block", async () => {
  const { bucket } = createTestBucket();
  const narrationDocument = {
    html: '<h1 id="unit-1">Title</h1><p id="unit-2">Body</p><p id="unit-3">continued</p>',
    synchronizationUnits: [
      { id: "unit-1", narrationText: "Title" },
      { id: "unit-2", narrationText: "Body" },
      { id: "unit-3", narrationText: "continued", continuesNarrationBlock: true },
    ],
  } satisfies StoredNarrationDocument;

  const reference = await storeAudiobook({
    bucket,
    conversionId: "conversion-id",
    title: "Title",
    originalUrl: "https://example.com",
    narrationDocument,
  });

  await expect(loadAudiobook({ bucket, audiobookReference: reference })).resolves.toMatchObject({
    narrationDocument,
  });
});
test.each([
  ["neither HTML nor a narration source material reference", {}],
  [
    "both HTML and a narration source material reference",
    {
      html: "<p>Body</p>",
      segmentationVersion: 1,
      narrationSourceMaterial: {
        key: "conversions/conversion-id/narration-source-material.html",
        contentType: "text/html; charset=utf-8",
        byteLength: 42,
        etag: "etag",
      },
    },
  ],
  [
    "an unknown segmentation version",
    {
      segmentationVersion: 99,
      narrationSourceMaterial: {
        key: "conversions/conversion-id/narration-source-material.html",
        contentType: "text/html; charset=utf-8",
        byteLength: 42,
        etag: "etag",
      },
    },
  ],
])("rejects a manifest whose narration document has %s", async (_description, shape) => {
  const { bucket, storedObjects } = createTestBucket();
  const reference = await storeAudiobook({
    bucket,
    conversionId: "conversion-id",
    title: "Title",
    originalUrl: "https://example.com",
    narrationDocument: document,
  });
  const body = JSON.stringify({
    title: "Title",
    originalUrl: "https://example.com",
    narrationDocument: { ...shape, synchronizationUnits: document.synchronizationUnits },
  });
  storedObjects.set(reference.key, { body, httpMetadata: { contentType: "application/json" } });

  await expect(
    loadAudiobook({
      bucket,
      audiobookReference: { ...reference, byteLength: new TextEncoder().encode(body).byteLength },
    }),
  ).rejects.toBeInstanceOf(z.ZodError);
});
test("rejects invalid narration before publishing a prepared artifact", async () => {
  const { bucket, storedObjects } = createTestBucket();
  await expect(
    storeAudiobook({
      bucket,
      conversionId: "conversion-id",
      title: "Title",
      originalUrl: "not a URL",
      narrationDocument: document,
    }),
  ).rejects.toThrow("Invalid URL");
  expect(storedObjects.size).toBe(0);
});
type StoredTestObject = {
  body: string;
  httpMetadata: { contentType?: string };
};

function createTestBucket(): {
  bucket: StoreOptions["bucket"];
  storedObjects: Map<string, StoredTestObject>;
} {
  const storedObjects = new Map<string, StoredTestObject>();
  const bucket: StoreOptions["bucket"] = {
    get: async (key: string) => {
      const storedObject = storedObjects.get(key);

      if (storedObject === undefined) {
        return null;
      }

      return {
        key,
        size: new TextEncoder().encode(storedObject.body).byteLength,
        etag: "manifest-etag",
        httpMetadata: storedObject.httpMetadata,
        text: async () => storedObject.body,
      };
    },
    put: async (key: string, value: string, options) => {
      storedObjects.set(key, { body: value, httpMetadata: options.httpMetadata });

      return {
        key,
        size: new TextEncoder().encode(value).byteLength,
        etag: "manifest-etag",
      };
    },
  };

  return { bucket, storedObjects };
}
