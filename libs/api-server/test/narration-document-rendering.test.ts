import { captureException } from "@sentry/core";
import { beforeEach, expect, test, vi } from "vitest";

import { SPEECH_CONFIG } from "@cup/audiobook-production";
import { createConversionArtifactPrefix, type ConversionOwner } from "@cup/conversion-contracts";
import { audiobookSchema } from "@cup/listener-api.routes";
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
// The helper itself is tested against the Sentry stub in @cup/telemetry.cloudflare.
vi.mock(import("@cup/telemetry.cloudflare"), async (importOriginal) => ({
  ...(await importOriginal()),
  logEvent: vi.fn<typeof logEvent>(),
}));
// Records the captures; the Worker integration tests check what reaches Sentry.
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
// Account requests carry a bearer token, trial requests their grant session cookie.
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
});

function fixture(owner: ConversionOwner, synchronizationUnits = SYNCHRONIZATION_UNITS) {
  const manifest = JSON.stringify({
    title: "A document",
    originalUrl: "https://publisher.example/articles/story",
    speechConfig: SPEECH_CONFIG,
    narrationDocument: { html: STORED_HTML, synchronizationUnits },
  });
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
      get: async (key: string) =>
        key === reference.key
          ? {
              size: reference.byteLength,
              etag: reference.etag,
              httpMetadata: { contentType: reference.contentType },
              text: async () => manifest,
            }
          : null,
    },
  };
  if (!isFixtureEnvironment(env)) {
    throw new Error("Missing narration document fixture bindings");
  }

  return {
    request: async () =>
      createApiServer().request(
        origin + audiobookPath,
        { headers: OWNER_HEADERS[owner.kind] },
        env,
      ),
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

function isFixtureEnvironment(value: unknown): value is ApiServerEnvironment {
  return typeof value === "object" && value !== null && "REGISTRY" in value;
}
