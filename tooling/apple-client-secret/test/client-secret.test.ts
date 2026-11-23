import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "vitest";

import { signAppleClientSecret } from "#src/client-secret.ts";

const DECEMBER_1_2026_AT_06_17_UTC_IN_SECONDS = 1_796_105_820;
const MAY_30_2027_AT_06_17_UTC_IN_SECONDS = 1_811_571_420;
const APPLE_MAXIMUM_LIFETIME_SECONDS = 15_777_000;

function generateThrowawayKey(namedCurve = "P-256") {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve });
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }), publicKey };
}

function splitJwt(jwt: string) {
  const [header, claims, signature, ...rest] = jwt.split(".");
  assert.ok(header !== undefined && claims !== undefined && signature !== undefined);
  assert.equal(rest.length, 0);
  return { header, claims, signature };
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

test("signs an ES256 client secret for the Services ID that verifies against the key's public key", () => {
  const { privateKeyPem, publicKey } = generateThrowawayKey();

  const secret = signAppleClientSecret(privateKeyPem, DECEMBER_1_2026_AT_06_17_UTC_IN_SECONDS);

  const { header, claims, signature } = splitJwt(secret);
  assert.deepEqual(decodeSegment(header), { alg: "ES256", kid: "6Y358M9M9A" });
  assert.deepEqual(decodeSegment(claims), {
    iss: "4GQ2V3WJW8",
    iat: DECEMBER_1_2026_AT_06_17_UTC_IN_SECONDS,
    exp: MAY_30_2027_AT_06_17_UTC_IN_SECONDS,
    aud: "https://appleid.apple.com",
    sub: "audio.cup.app.web",
  });

  const signatureBytes = Buffer.from(signature, "base64url");
  assert.equal(signatureBytes.length, 64);
  assert.ok(
    crypto.verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signatureBytes,
    ),
  );
});

test("keeps the lifetime just under 180 days, below Apple's six-month limit", () => {
  const lifetimeSeconds =
    MAY_30_2027_AT_06_17_UTC_IN_SECONDS - DECEMBER_1_2026_AT_06_17_UTC_IN_SECONDS;

  assert.ok(lifetimeSeconds < APPLE_MAXIMUM_LIFETIME_SECONDS);
  assert.ok(lifetimeSeconds < 180 * 86_400);
  assert.ok(lifetimeSeconds >= 179 * 86_400);
});

test("rejects a key that is not a P-256 private key", () => {
  const { privateKeyPem } = generateThrowawayKey("P-384");

  assert.throws(
    () => signAppleClientSecret(privateKeyPem, DECEMBER_1_2026_AT_06_17_UTC_IN_SECONDS),
    /P-256/,
  );
});
