import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Temporal } from "temporal-polyfill";
import { afterEach, expect, test, vi } from "vitest";

import { SPEECH_CONFIG } from "@cup/audiobook-production";
import { createConversionArtifactPrefix, type ConversionOwner } from "@cup/conversion-contracts";
import { audiobookSchema } from "@cup/listener-api.routes";

import type { ApiServerEnvironment } from "#src/api-server-environment.ts";
import { createApiServer } from "#src/api-server.ts";
import { signMediaUrl } from "#src/http/signed-media-url.ts";

vi.mock("@cup/conversion-grants", async () => ({
  ...(await import("@cup/conversion-grants/contracts")),
  ...(await import("@cup/conversion-grants/session")),
}));

const SIGNING_KEY = "test-media-url-signing-key";
const HOUR_MS = 60 * 60 * 1_000;
const conversionId = "f9cc2e59-46a3-4890-b923-bda04d03b4d0";
const accountId = "d1a52e64-3e4d-4a7f-a711-7fb11501e9af";
const grantId = "6b0f5f2e-8d7c-4b8e-9a51-0f7c3c2d1e4a";
const subject = "f355f913-ba12-45d6-a7d2-4df95f7cf11f";
const supabaseUrl = "https://access-test.supabase.co";
const origin = "https://cup.audio";
const audiobookPath = `/api/audiobooks/${conversionId}`;
const positionPath = `/api/audiobooks/${conversionId}/position`;
const narrationTrackPath = `/api/files/audiobooks/${conversionId}/narration-track.mp3`;
const coverImagePath = `/api/files/audiobooks/${conversionId}/cover-image`;
const grantCookie = `__Secure-grant-session-${grantId}=valid-session`;
const accountOwner: ConversionOwner = { kind: "account", accountId };
const trialOwner: ConversionOwner = { kind: "trial", grantId };
const position = { synchronizationUnitId: "synchronization-unit-1", offsetMilliseconds: 420 };
const mutationHeaders = {
  "Content-Type": "application/json",
  "X-Create-Audiobook-From-URL-Request": "1",
};
const keys = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "signed-position-url" };

afterEach(() => vi.unstubAllGlobals());

function fixture(owner: ConversionOwner) {
  const artifactPrefix = createConversionArtifactPrefix(conversionId, owner);
  const manifest = JSON.stringify({
    title: "A document",
    originalUrl: "https://example.com/source",
    speechConfig: SPEECH_CONFIG,
    narrationDocument: {
      html: '<h1 id="synchronization-unit-1">A document</h1>',
      synchronizationUnits: [{ id: "synchronization-unit-1", narrationText: "A document" }],
    },
    coverImage: { contentType: "image/jpeg", byteLength: 3 },
  });
  const reference = {
    key: `${artifactPrefix}audiobook.json`,
    contentType: "application/json",
    byteLength: manifest.length,
    etag: "manifest-etag",
  };
  async function readBucket(key: string) {
    if (key === reference.key) {
      return {
        size: reference.byteLength,
        etag: reference.etag,
        httpMetadata: { contentType: reference.contentType },
        text: async () => manifest,
      };
    }
    if (key === `${artifactPrefix}cover-image`) {
      return { size: 3, httpEtag: '"cover-etag"', body: new Uint8Array([1, 2, 3]) };
    }
    return null;
  }

  const accountState = { current: "active" };
  const conversionState = { isDeleted: false };
  const savedPositions: { accountId: string; conversionId: string; position: unknown }[] = [];
  function createAccount(id: string) {
    return {
      inspect: async () => ({
        accountId: id,
        subject,
        createdAtMs: 1,
        executionEpoch: 1,
        state: accountState.current,
        balance: { unit: "audio-millisecond", available: 1_800_000, reserved: 0 },
      }),
      getConversion: async () =>
        id !== accountId || conversionState.isDeleted
          ? undefined
          : {
              status: "ready",
              sourceUrl: "https://example.com/source",
              outcome: { status: "ready", audiobookReference: reference },
            },
      listAudioSegments: async () => [{ sequence: 0, state: "settled", actualMilliseconds: 960 }],
      getPlaybackPosition: async () => null,
      savePlaybackPosition: async (savedConversionId: string, savedPosition: unknown) => {
        savedPositions.push({
          accountId: id,
          conversionId: savedConversionId,
          position: savedPosition,
        });
      },
    };
  }

  const grant = {
    inspect: async () => ({ state: "open" }),
    validateSession: async (token: string) =>
      token === "valid-session"
        ? { result: "valid" as const, snapshot: { state: "open" } }
        : { result: "invalid" as const },
    getConversion: async () => ({ status: "ready", sourceUrl: "https://example.com/source" }),
    getReadyAudiobookReference: async () => reference,
    listAudioSegments: async () => [{ sequence: 0, state: "settled", actualMilliseconds: 960 }],
  };

  const env = {
    SUPABASE_URL: supabaseUrl,
    MEDIA_URL_SIGNING_KEY: SIGNING_KEY,
    ACCOUNTS: { idFromName: (name: string) => name, get: createAccount },
    CONVERSION_GRANTS: { idFromName: (name: string) => name, get: () => grant },
    REGISTRY: {
      idFromName: (name: string) => name,
      get: () => ({
        findIdentity: async () => ({ accountId, subject, phase: "active" }),
        findConversionOwner: async (id: string) => (id === conversionId ? owner : undefined),
      }),
    },
    AUDIO_BUCKET: { get: readBucket },
  };
  if (!isFixtureEnvironment(env)) {
    throw new Error("Missing signed position URL fixture bindings");
  }
  return { app: createApiServer(), env, accountState, conversionState, savedPositions };
}

async function createAccessToken() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [jwk] })),
  );
  return new SignJWT({
    role: "authenticated",
    is_anonymous: false,
    app_metadata: { provider: "google" },
  })
    .setProtectedHeader({ alg: "ES256", kid: "signed-position-url" })
    .setSubject(subject)
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

function signPositionUrl(
  overrides: {
    principal?: ConversionOwner;
    conversionId?: string;
    nowMs?: number;
    signingKey?: string;
  } = {},
) {
  return signMediaUrl({
    url: origin + positionPath,
    conversionId: overrides.conversionId ?? conversionId,
    principal: overrides.principal ?? accountOwner,
    signingKey: overrides.signingKey ?? SIGNING_KEY,
    nowMs: overrides.nowMs ?? Temporal.Now.instant().epochMilliseconds,
    purpose: "position",
  });
}

function putPosition(
  app: ReturnType<typeof createApiServer>,
  env: ApiServerEnvironment,
  url: string,
  headers: Record<string, string> = {},
  body: unknown = position,
) {
  return app.request(
    url,
    { method: "PUT", headers: { ...mutationHeaders, ...headers }, body: JSON.stringify(body) },
    env,
  );
}

async function getAudiobook(
  app: ReturnType<typeof createApiServer>,
  env: ApiServerEnvironment,
  headers: Record<string, string>,
) {
  const response = await app.request(origin + audiobookPath, { headers }, env);
  expect(response.status).toBe(200);
  const audiobook = audiobookSchema.parse(await response.json());
  if (!("narrationTrack" in audiobook) || audiobook.narrationTrack === undefined) {
    throw new Error("The audiobook response has no narration track");
  }
  return audiobook.narrationTrack;
}

async function expectErrorCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}

test("an account's audiobook response carries a position URL that saves the position without the session", async () => {
  const { app, env, savedPositions } = fixture(accountOwner);
  const narrationTrack = await getAudiobook(app, env, {
    Authorization: `Bearer ${await createAccessToken()}`,
  });
  const positionUrl = narrationTrack.positionUrl ?? "";
  expect(positionUrl.startsWith(`${origin + positionPath}?token=v1.`)).toBe(true);

  const response = await putPosition(app, env, positionUrl);
  expect(response.status).toBe(204);
  expect(savedPositions).toEqual([{ accountId, conversionId, position }]);
});

test("a trial's audiobook response carries no position URL", async () => {
  const { app, env } = fixture(trialOwner);
  const narrationTrack = await getAudiobook(app, env, { Cookie: grantCookie });
  expect(narrationTrack.url.startsWith(`${origin + narrationTrackPath}?token=`)).toBe(true);
  expect(narrationTrack.positionUrl).toBeUndefined();
});

test("the position route refuses a track or cover token, and media routes refuse a position token", async () => {
  const { app, env, savedPositions } = fixture(accountOwner);
  for (const mediaPath of [narrationTrackPath, coverImagePath]) {
    const mediaToken = new URL(
      await signMediaUrl({
        url: origin + mediaPath,
        conversionId,
        principal: accountOwner,
        signingKey: SIGNING_KEY,
        nowMs: Temporal.Now.instant().epochMilliseconds,
      }),
    ).searchParams.get("token");
    const url = new URL(origin + positionPath);
    url.searchParams.set("token", mediaToken ?? "");
    await expectErrorCode(await putPosition(app, env, url.href), 401, "position-url-invalid");
  }
  expect(savedPositions).toEqual([]);

  const positionToken = new URL(await signPositionUrl()).searchParams.get("token") ?? "";
  for (const mediaPath of [narrationTrackPath, coverImagePath]) {
    const url = new URL(origin + mediaPath);
    url.searchParams.set("token", positionToken);
    await expectErrorCode(await app.request(url.href, {}, env), 401, "media-url-invalid");
  }
});

test("a request with both credentials or neither answers 401 and saves nothing", async () => {
  const { app, env, savedPositions } = fixture(accountOwner);
  const bearer = { Authorization: `Bearer ${await createAccessToken()}` };
  expect((await putPosition(app, env, await signPositionUrl(), bearer)).status).toBe(401);
  expect((await putPosition(app, env, origin + positionPath)).status).toBe(401);
  expect(savedPositions).toEqual([]);
});

test("a tampered, expired, rotated-key or other-audiobook position token answers 401 position-url-invalid", async () => {
  const { app, env, savedPositions } = fixture(accountOwner);
  const validToken = new URL(await signPositionUrl()).searchParams.get("token") ?? "";
  const tamperedToken = validToken.slice(0, -2) + (validToken.endsWith("AA") ? "BB" : "AA");
  for (const token of [
    "not-a-token",
    tamperedToken,
    new URL(
      await signPositionUrl({ nowMs: Temporal.Now.instant().epochMilliseconds - 48 * HOUR_MS }),
    ).searchParams.get("token"),
    new URL(await signPositionUrl({ signingKey: "rotated-key" })).searchParams.get("token"),
    new URL(await signPositionUrl({ conversionId: crypto.randomUUID() })).searchParams.get("token"),
  ]) {
    const url = new URL(origin + positionPath);
    url.searchParams.set("token", token ?? "");
    await expectErrorCode(await putPosition(app, env, url.href), 401, "position-url-invalid");
  }
  expect(savedPositions).toEqual([]);
});

test("a position token handed out within the last 24 hours is still accepted", async () => {
  const { app, env } = fixture(accountOwner);
  const url = await signPositionUrl({
    nowMs: Temporal.Now.instant().epochMilliseconds - 24 * HOUR_MS + 60_000,
  });
  expect((await putPosition(app, env, url)).status).toBe(204);
});

test("a position token for another account, or for a trial's audiobook, answers 404", async () => {
  for (const [owner, principal] of [
    [accountOwner, { kind: "account", accountId: crypto.randomUUID() }],
    [trialOwner, accountOwner],
  ] as const) {
    const { app, env, savedPositions } = fixture(owner);
    await expectErrorCode(
      await putPosition(app, env, await signPositionUrl({ principal })),
      404,
      "audiobook-not-found",
    );
    expect(savedPositions).toEqual([]);
  }
});

test("the bearer path saves a trial's audiobook position to the signed-in listener's account when the request's grant covers it", async () => {
  const { app, env, savedPositions } = fixture(trialOwner);
  const response = await putPosition(app, env, origin + positionPath, {
    Authorization: `Bearer ${await createAccessToken()}`,
    Cookie: grantCookie,
  });
  expect(response.status).toBe(204);
  expect(savedPositions).toEqual([{ accountId, conversionId, position }]);
});

test("the bearer path refuses a trial's audiobook without the grant's session", async () => {
  const { app, env, savedPositions } = fixture(trialOwner);
  const response = await putPosition(app, env, origin + positionPath, {
    Authorization: `Bearer ${await createAccessToken()}`,
  });
  await expectErrorCode(response, 401, "grant-session-required");
  expect(savedPositions).toEqual([]);
});

test("a position token answers 404 for a trial's audiobook even when the request's grant covers it", async () => {
  const { app, env, savedPositions } = fixture(trialOwner);
  const response = await putPosition(app, env, await signPositionUrl(), { Cookie: grantCookie });
  await expectErrorCode(response, 404, "audiobook-not-found");
  expect(savedPositions).toEqual([]);
});

test("both paths answer 404 for a deleted audiobook", async () => {
  const { app, env, conversionState, savedPositions } = fixture(accountOwner);
  conversionState.isDeleted = true;
  await expectErrorCode(
    await putPosition(app, env, await signPositionUrl()),
    404,
    "audiobook-not-found",
  );
  await expectErrorCode(
    await putPosition(app, env, origin + positionPath, {
      Authorization: `Bearer ${await createAccessToken()}`,
    }),
    404,
    "audiobook-not-found",
  );
  expect(savedPositions).toEqual([]);
});

test("both paths answer the blocked response once the account's deletion is scheduled", async () => {
  const { app, env, accountState, savedPositions } = fixture(accountOwner);
  const positionUrl = await signPositionUrl();
  const bearer = { Authorization: `Bearer ${await createAccessToken()}` };
  accountState.current = "deletion_scheduled";
  await expectErrorCode(await putPosition(app, env, positionUrl), 403, "account-blocked");
  await expectErrorCode(
    await putPosition(app, env, origin + positionPath, bearer),
    403,
    "account-blocked",
  );
  expect(savedPositions).toEqual([]);
});

test("the position URL still needs the browser-mutation headers and an allowed origin", async () => {
  const { app, env, savedPositions } = fixture(accountOwner);
  const positionUrl = await signPositionUrl();
  // The route's request validation answers 400 for the missing header before the handler runs.
  expect(
    (await putPosition(app, env, positionUrl, { "X-Create-Audiobook-From-URL-Request": "" }))
      .status,
  ).toBe(400);
  await expectErrorCode(
    await putPosition(app, env, positionUrl, { Origin: "https://attacker.example" }),
    403,
    "origin-blocked",
  );
  expect(savedPositions).toEqual([]);
});

test("a position for a synchronization unit the audiobook lacks answers 400", async () => {
  const { app, env, savedPositions } = fixture(accountOwner);
  const response = await putPosition(
    app,
    env,
    await signPositionUrl(),
    {},
    {
      synchronizationUnitId: "synchronization-unit-2",
      offsetMilliseconds: 0,
    },
  );
  await expectErrorCode(response, 400, "invalid-input");
  expect(savedPositions).toEqual([]);
});

function isFixtureEnvironment(value: unknown): value is ApiServerEnvironment {
  return (
    typeof value === "object" &&
    value !== null &&
    "ACCOUNTS" in value &&
    "CONVERSION_GRANTS" in value &&
    "REGISTRY" in value &&
    "AUDIO_BUCKET" in value
  );
}
