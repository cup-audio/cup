import { captureException } from "@sentry/core";
import { Temporal } from "temporal-polyfill";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { SPEECH_CONFIG } from "@cup/audiobook-production";
import { createConversionArtifactPrefix, type ConversionOwner } from "@cup/conversion-contracts";
import { audiobookResponseSchema, audiobookSchema } from "@cup/listener-api.routes";
import { renderNarrationDocument } from "@cup/narration-document-creation";
import { logEvent } from "@cup/telemetry.cloudflare";

import type { ApiServerEnvironment } from "#src/api-server-environment.ts";
import { createApiServer } from "#src/api-server.ts";

import { toStrictSchema } from "#test/strict-schema.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly mocked = true;
  },
}));
vi.mock("@cup/conversion-grants", async () => ({
  ...(await import("@cup/conversion-grants/contracts")),
  ...(await import("@cup/conversion-grants/session")),
}));
const mocks = vi.hoisted(() => ({
  authenticate: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock("#src/http/ingress-identity.ts", () => ({ ingressIdentity: async () => "ingress-key" }));
vi.mock("#src/http/account-auth.ts", async (original) => ({
  ...(await original<typeof import("#src/http/account-auth.ts")>()),
  authenticateAccountRequest: mocks.authenticate,
}));
vi.mock(import("@cup/telemetry.cloudflare"), async (importOriginal) => ({
  ...(await importOriginal()),
  logEvent: vi.fn<typeof logEvent>(),
}));
vi.mock("@cup/narration-document-creation", async (importOriginal) => {
  const original = await importOriginal<typeof import("@cup/narration-document-creation")>();
  return {
    ...original,
    renderNarrationDocument: vi.fn<typeof original.renderNarrationDocument>(
      original.renderNarrationDocument,
    ),
  };
});
vi.mock(import("@sentry/core"), async (importOriginal) => ({
  ...(await importOriginal()),
  captureException: vi.fn<typeof captureException>(),
}));

const conversionId = "f9cc2e59-46a3-4890-b923-bda04d03b4d0";
const accountId = "d1a52e64-3e4d-4a7f-a711-7fb11501e9af";
const grantId = "6b0f5f2e-8d7c-4b8e-9a51-0f7c3c2d1e4a";
const origin = "https://cup.audio";
const audiobookPath = `/api/audiobooks/${conversionId}`;
const OWNERS: Record<ConversionOwner["kind"], ConversionOwner> = {
  account: { kind: "account", accountId },
  trial: { kind: "trial", grantId },
};
const OWNER_HEADERS: Record<ConversionOwner["kind"], Record<string, string>> = {
  account: { Authorization: "Bearer token" },
  trial: { Cookie: `__Secure-grant-session-${grantId}=valid-session` },
};

const STORED_HTML =
  '<article><h1 id="narration-unit-0001">A document</h1><section id="narration-unit-0002"><h2>A section</h2><p lang="en">See <a href="/cited">the source</a>.</p></section></article>';
const SYNCHRONIZATION_UNITS = [
  { id: "narration-unit-0001", narrationText: "A document" },
  { id: "narration-unit-0002", narrationText: "A section\n\nSee the source." },
];

beforeEach(() => {
  vi.mocked(captureException).mockClear();
  vi.mocked(logEvent).mockClear();
  vi.mocked(renderNarrationDocument).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

function fixture(
  owner: ConversionOwner,
  synchronizationUnits = SYNCHRONIZATION_UNITS,
  {
    narrationDocument = { html: STORED_HTML, synchronizationUnits },
    storedObjects = {},
    title = "A document",
  }: {
    narrationDocument?: object;
    title?: string;
    storedObjects?: Record<string, string>;
  } = {},
) {
  const manifest = JSON.stringify({
    title,
    originalUrl: "https://publisher.example/articles/story",
    speechConfig: SPEECH_CONFIG,
    narrationDocument,
  });
  const readKeys: string[] = [];
  const reference = {
    key: `${createConversionArtifactPrefix(conversionId, owner)}audiobook.json`,
    contentType: "application/json",
    byteLength: manifest.length,
    etag: "manifest-etag",
  };
  const conversion = {
    status: "ready",
    sourceUrl: "https://publisher.example/articles/story",
    outcome: { status: "ready", audiobookReference: reference },
  };
  const segments = [{ sequence: 0, state: "settled", actualMilliseconds: 1_000 }];
  const account = {
    inspect: async () => ({ accountId, state: "active", balance: { available: 60_000 } }),
    getConversion: async () => conversion,
    listAudioSegments: async () => segments,
    getPlaybackPosition: async () => null,
  };
  const grant = {
    inspect: async () => ({ state: "open", duration: { availableMilliseconds: 60_000 } }),
    validateSession: async (token: string) =>
      token === "valid-session"
        ? { result: "valid" as const, snapshot: { state: "open" } }
        : { result: "invalid" as const },
    getConversion: async () => conversion,
    getReadyAudiobookReference: async () => reference,
    listAudioSegments: async () => segments,
  };
  mocks.authenticate.mockResolvedValue({
    result: "authenticated",
    snapshot: { accountId, state: "active" },
    account,
  });

  const env = {
    SUPABASE_URL: "https://access-test.supabase.co",
    MEDIA_URL_SIGNING_KEY: "test-media-url-signing-key",
    ACCOUNTS: { idFromName: (name: string) => name, get: () => account },
    CONVERSION_GRANTS: { idFromName: (name: string) => name, get: () => grant },
    REGISTRY: {
      idFromName: (name: string) => name,
      get: () => ({
        consumeIngressRequest: async () => undefined,
        findConversionOwner: async () => owner,
      }),
    },
    AUDIO_BUCKET: {
      get: async (key: string) => {
        readKeys.push(key);
        if (key === reference.key) {
          return {
            size: reference.byteLength,
            etag: reference.etag,
            httpMetadata: { contentType: reference.contentType },
            text: async () => manifest,
          };
        }
        const storedObject = storedObjects[key];
        return storedObject === undefined
          ? null
          : {
              size: new TextEncoder().encode(storedObject).byteLength,
              etag: "source-material-etag",
              httpMetadata: { contentType: "text/html; charset=utf-8" },
              text: async () => storedObject,
            };
      },
    },
  };
  if (!isFixtureEnvironment(env)) {
    throw new Error("Missing narration document fixture bindings");
  }

  return {
    readKeys,
    request: async (path = audiobookPath) =>
      createApiServer().request(origin + path, { headers: OWNER_HEADERS[owner.kind] }, env),
  };
}

test.for(["account", "trial"] as const)(
  "the %s audiobook carries the rendered narration document in the unchanged response shape",
  async (ownerKind) => {
    const response = await fixture(OWNERS[ownerKind]).request();

    expect(response.status).toBe(200);
    expect(toStrictSchema(audiobookSchema).parse(await response.json())).toMatchObject({
      narrationDocument: {
        html: '<article><h1 data-synchronization-unit="narration-unit-0001">A document</h1><h2 data-synchronization-unit="narration-unit-0002">A section</h2><p data-synchronization-unit="narration-unit-0002">See <a href="https://publisher.example/cited">the source</a>.</p></article>',
        synchronizationUnits: SYNCHRONIZATION_UNITS,
      },
    });
    expect(captureException).not.toHaveBeenCalled();
  },
);

test.for(["account", "trial"] as const)(
  "a %s audiobook whose render disagrees with its units serves the fallback and reports the first differing unit",
  async (ownerKind) => {
    const synchronizationUnits = [
      SYNCHRONIZATION_UNITS[0]!,
      { id: "narration-unit-0002", narrationText: "A section\n\nSee another source." },
    ];

    const response = await fixture(OWNERS[ownerKind], synchronizationUnits).request();

    expect(response.status).toBe(200);
    expect(toStrictSchema(audiobookSchema).parse(await response.json())).toMatchObject({
      narrationDocument: {
        html: '<article><p data-synchronization-unit="narration-unit-0001">A document</p><p data-synchronization-unit="narration-unit-0002">A section<br><br>See another source.</p></article>',
        synchronizationUnits,
      },
    });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        "cup.conversion.id": conversionId,
        "cup.synchronization_unit.id": "narration-unit-0002",
      },
    });
    expect(logEvent).toHaveBeenCalledWith("narration-document-mismatch", expect.any(String), {
      attributes: {
        "cup.conversion.id": conversionId,
        "cup.synchronization_unit.id": "narration-unit-0002",
        "cup.narration_document.mismatch_reason": "narration-text",
      },
    });
  },
);

const NARRATION_SOURCE_MATERIAL_HTML =
  '<h2 data-raw-source-material="kept">A section</h2><p>See <a href="/cited">the source</a>.</p>';
const AUDIOBOOK_SOURCE_MATERIAL_HTML =
  '<nav data-raw-source-material="kept">Site navigation</nav><h2>A section</h2><p>See <a href="/cited">the source</a>.</p>';
const NEW_SHAPE_UNITS = [
  { id: "narration-unit-0001", narrationText: "A document" },
  { id: "narration-unit-0002", narrationText: "A subtitle" },
  { id: "narration-unit-0003", narrationText: "A section\n\nSee the source." },
];

function newShapeFixture(
  owner: ConversionOwner,
  {
    fetchedUrl,
    segmentationVersion = 2,
    narrationSourceMaterialHtml = NARRATION_SOURCE_MATERIAL_HTML,
    storedNarrationSourceMaterialHtml = narrationSourceMaterialHtml,
    synchronizationUnits = NEW_SHAPE_UNITS,
    title,
  }: {
    fetchedUrl?: string;
    segmentationVersion?: 1 | 2;
    narrationSourceMaterialHtml?: string;
    storedNarrationSourceMaterialHtml?: string | null;
    synchronizationUnits?: typeof NEW_SHAPE_UNITS;
    title?: string;
  } = {},
) {
  const artifactPrefix = createConversionArtifactPrefix(conversionId, owner);
  const narrationSourceMaterialKey = `${artifactPrefix}narration-source-material.html`;

  return fixture(owner, synchronizationUnits, {
    narrationDocument: {
      segmentationVersion,
      narrationSourceMaterial: {
        key: narrationSourceMaterialKey,
        contentType: "text/html; charset=utf-8",
        byteLength: new TextEncoder().encode(narrationSourceMaterialHtml).byteLength,
        etag: "source-material-etag",
      },
      ...(fetchedUrl === undefined ? {} : { fetchedUrl }),
      sourceSubtitle: "A subtitle",
      synchronizationUnits,
    },
    ...(title === undefined ? {} : { title }),
    storedObjects: {
      ...(storedNarrationSourceMaterialHtml === null
        ? {}
        : { [narrationSourceMaterialKey]: storedNarrationSourceMaterialHtml }),
      [`${artifactPrefix}audiobook-source-material.html`]: AUDIOBOOK_SOURCE_MATERIAL_HTML,
    },
  });
}

test.for(["account", "trial"] as const)(
  "a new %s conversion's narration document is rendered from the narration source material its manifest references, with links resolved against the fetched URL",
  async (ownerKind) => {
    const owner = OWNERS[ownerKind];
    const { readKeys, request } = newShapeFixture(owner, {
      fetchedUrl: "https://www.publisher.example/2026/story",
    });

    const response = await request();

    expect(response.status).toBe(200);
    expect(toStrictSchema(audiobookSchema).parse(await response.json())).toMatchObject({
      narrationDocument: {
        html: '<article><hgroup><h1 data-synchronization-unit="narration-unit-0001">A document</h1><p data-synchronization-unit="narration-unit-0002">A subtitle</p></hgroup><h2 data-synchronization-unit="narration-unit-0003">A section</h2><p data-synchronization-unit="narration-unit-0003">See <a href="https://www.publisher.example/cited">the source</a>.</p></article>',
        synchronizationUnits: NEW_SHAPE_UNITS,
      },
    });
    const artifactPrefix = createConversionArtifactPrefix(conversionId, owner);
    expect(readKeys.filter((key) => key.endsWith(".html"))).toEqual([
      `${artifactPrefix}narration-source-material.html`,
    ]);
    expect(captureException).not.toHaveBeenCalled();
  },
);

const TABLE_SOURCE_MATERIAL_HTML =
  "<h2>Latency</h2><table><tr><th>Region</th><th>Latency</th></tr><tr><td>Europe</td><td>380 ms</td></tr></table>";
const RENDERED_TABLES_BY_SEGMENTATION_VERSION = {
  1: {
    synchronizationUnits: [
      ...NEW_SHAPE_UNITS.slice(0, 2),
      { id: "narration-unit-0003", narrationText: "Latency\n\nRegion" },
      { id: "narration-unit-0004", narrationText: "Latency" },
      { id: "narration-unit-0005", narrationText: "Europe" },
      { id: "narration-unit-0006", narrationText: "380 ms" },
    ],
    body: '<h2 data-synchronization-unit="narration-unit-0003">Latency</h2><div data-scroll-card=""><table><tbody><tr><th data-synchronization-unit="narration-unit-0003">Region</th><th data-synchronization-unit="narration-unit-0004">Latency</th></tr><tr><td data-synchronization-unit="narration-unit-0005">Europe</td><td data-synchronization-unit="narration-unit-0006">380 ms</td></tr></tbody></table></div>',
  },
  2: {
    synchronizationUnits: [
      ...NEW_SHAPE_UNITS.slice(0, 2),
      { id: "narration-unit-0003", narrationText: "Latency\n\nRegion, Latency" },
      { id: "narration-unit-0004", narrationText: "Europe, 380 ms" },
    ],
    body: '<h2 data-synchronization-unit="narration-unit-0003">Latency</h2><div data-scroll-card=""><table><tbody><tr data-synchronization-unit="narration-unit-0003"><th>Region</th><th>Latency</th></tr><tr data-synchronization-unit="narration-unit-0004"><td>Europe</td><td>380 ms</td></tr></tbody></table></div>',
  },
} as const;

test.for([1, 2] as const)(
  "a new conversion prepared with segmentation version %i is rendered from the same narration source material with its own stored units",
  async (segmentationVersion) => {
    const { synchronizationUnits, body } =
      RENDERED_TABLES_BY_SEGMENTATION_VERSION[segmentationVersion];

    const response = await newShapeFixture(OWNERS.account, {
      segmentationVersion,
      narrationSourceMaterialHtml: TABLE_SOURCE_MATERIAL_HTML,
      synchronizationUnits: [...synchronizationUnits],
    }).request();

    expect(response.status).toBe(200);
    expect(toStrictSchema(audiobookSchema).parse(await response.json())).toMatchObject({
      narrationDocument: {
        html: `<article><hgroup><h1 data-synchronization-unit="narration-unit-0001">A document</h1><p data-synchronization-unit="narration-unit-0002">A subtitle</p></hgroup>${body}</article>`,
        synchronizationUnits,
      },
    });
    expect(captureException).not.toHaveBeenCalled();
  },
);

test("a new conversion without a fetched URL resolves its links against the submitted source URL", async () => {
  const response = await newShapeFixture(OWNERS.account).request();

  expect(response.status).toBe(200);
  expect(toStrictSchema(audiobookSchema).parse(await response.json())).toMatchObject({
    narrationDocument: {
      html: expect.stringContaining('<a href="https://publisher.example/cited">the source</a>'),
    },
  });
});

test("a new conversion whose segmentation disagrees with its stored units serves the fallback and reports the first differing unit", async () => {
  const synchronizationUnits = [
    ...NEW_SHAPE_UNITS.slice(0, 2),
    { id: "narration-unit-0003", narrationText: "A section\nSee the source." },
  ];

  const response = await newShapeFixture(OWNERS.trial, { synchronizationUnits }).request();

  expect(response.status).toBe(200);
  expect(toStrictSchema(audiobookSchema).parse(await response.json())).toMatchObject({
    narrationDocument: {
      html: '<article><p data-synchronization-unit="narration-unit-0001">A document</p><p data-synchronization-unit="narration-unit-0002">A subtitle</p><p data-synchronization-unit="narration-unit-0003">A section<br>See the source.</p></article>',
      synchronizationUnits,
    },
  });
  expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
    tags: {
      "cup.conversion.id": conversionId,
      "cup.synchronization_unit.id": "narration-unit-0003",
    },
  });
});

const NEW_SHAPE_FALLBACK_HTML =
  '<article><p data-synchronization-unit="narration-unit-0001">A document</p><p data-synchronization-unit="narration-unit-0002">A subtitle</p><p data-synchronization-unit="narration-unit-0003">A section<br><br>See the source.</p></article>';

test.for([
  {
    failure: "the narration source material is missing",
    options: { storedNarrationSourceMaterialHtml: null },
    rootCause: "Narration source material was not found in storage",
  },
  {
    failure: "the stored narration source material isn't the object its reference describes",
    options: { storedNarrationSourceMaterialHtml: `${NARRATION_SOURCE_MATERIAL_HTML}<p>More.</p>` },
    rootCause: "Stored narration source material does not match its reference",
  },
  {
    failure: "segmentation throws",
    options: { title: " " },
    rootCause: "Expected the source title to contain narration text",
  },
])(
  "a new conversion whose render fails because $failure serves the fallback and reports the failure",
  async ({ options, rootCause }) => {
    const response = await newShapeFixture(OWNERS.account, options).request();

    expect(response.status).toBe(200);
    expect(toStrictSchema(audiobookSchema).parse(await response.json())).toMatchObject({
      narrationDocument: {
        html: NEW_SHAPE_FALLBACK_HTML,
        synchronizationUnits: NEW_SHAPE_UNITS,
      },
    });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: expect.objectContaining({ message: expect.stringContaining(rootCause) }),
      }),
      { tags: { "cup.conversion.id": conversionId } },
    );
    expect(logEvent).toHaveBeenCalledWith("narration-document-render-failure", expect.any(String), {
      attributes: { "cup.conversion.id": conversionId },
      error: expect.objectContaining({ message: expect.stringContaining(rootCause) }),
    });
  },
);

test("an existing conversion never reads a narration source material object its manifest doesn't record", async () => {
  const owner = OWNERS.account;
  const { readKeys, request } = fixture(owner, SYNCHRONIZATION_UNITS, {
    storedObjects: {
      [`${createConversionArtifactPrefix(conversionId, owner)}narration-source-material.html`]:
        NARRATION_SOURCE_MATERIAL_HTML,
    },
  });

  expect((await request()).status).toBe(200);
  expect(readKeys.filter((key) => key.endsWith(".html"))).toEqual([]);
});

test.for(["account", "trial"] as const)(
  "no %s route returns either stored source material's content",
  async (ownerKind) => {
    const { request } = newShapeFixture(OWNERS[ownerKind]);

    const paths = [
      audiobookPath,
      `${audiobookPath}/narration-source-material.html`,
      `${audiobookPath}/audiobook-source-material.html`,
      `${audiobookPath}/narration-source-material`,
      `${audiobookPath}/source-material`,
    ];
    const pathsServingSourceMaterial: string[] = [];

    for (const path of paths) {
      const body = await (await request(path)).text();
      if (body.includes("data-raw-source-material") || body.includes("Site navigation")) {
        pathsServingSourceMaterial.push(path);
      }
    }

    expect(pathsServingSourceMaterial).toEqual([]);
  },
);

test.for(["account", "trial"] as const)(
  "a %s audiobook requested without its narration document neither reads nor renders it and still answers every other field",
  async (ownerKind) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Temporal.Instant.from("2026-11-20T09:00:00Z").epochMilliseconds);
    const { readKeys, request } = newShapeFixture(OWNERS[ownerKind]);
    const withDocument = toStrictSchema(audiobookSchema).parse(await (await request()).json());
    const withoutDocument = Object.fromEntries(
      Object.entries(withDocument).filter(([key]) => key !== "narrationDocument"),
    );
    vi.mocked(renderNarrationDocument).mockClear();
    readKeys.length = 0;

    const response = await request(`${audiobookPath}?narrationDocument=omit`);

    expect(response.status).toBe(200);
    expect(toStrictSchema(audiobookResponseSchema).parse(await response.json())).toStrictEqual(
      withoutDocument,
    );
    expect(renderNarrationDocument).not.toHaveBeenCalled();
    expect(readKeys.filter((key) => key.endsWith(".html"))).toStrictEqual([]);
  },
);

test("an audiobook requested with an unknown narration document choice is refused", async () => {
  const response = await fixture(OWNERS.account).request(`${audiobookPath}?narrationDocument=skip`);

  expect(response.status).toBe(400);
});

function isFixtureEnvironment(value: unknown): value is ApiServerEnvironment {
  return typeof value === "object" && value !== null && "REGISTRY" in value;
}
