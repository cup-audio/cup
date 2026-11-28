import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { expect, test } from "vitest";

import { verifyAccountToken } from "#src/http/account-auth.ts";

const url = "https://cup-test.supabase.co";
const subject = "f355f913-ba12-45d6-a7d2-4df95f7cf11f";
const testAccountEmail = "test@cup.local";
const google = { app_metadata: { provider: "google", providers: ["google"] } };

async function fixture() {
  const keys = await generateKeyPair("ES256");
  const publicKey = { ...(await exportJWK(keys.publicKey)), kid: "test" };
  const jwks = createLocalJWKSet({ keys: [publicKey] });
  const token = (
    claims: JWTPayload = google,
    issuer = `${url}/auth/v1`,
    audience = "authenticated",
    expiry = "5m",
  ) =>
    new SignJWT({ role: "authenticated", is_anonymous: false, ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "test" })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expiry)
      .sign(keys.privateKey);
  return { token, jwks };
}

test("accepts a correctly signed account identity", async () => {
  const { token, jwks } = await fixture();
  expect((await verifyAccountToken(await token(), { supabaseUrl: url }, jwks)).subject).toBe(
    subject,
  );
});

test("rejects expired, foreign issuer, foreign audience and forged JWTs", async () => {
  const { token, jwks } = await fixture();
  for (const jwt of [
    await token(google, "https://other.supabase.co/auth/v1"),
    await token(google, undefined, "service_role"),
    await token(google, undefined, undefined, "-5m"),
    `${await token()}forged`,
  ]) {
    await expect(verifyAccountToken(jwt, { supabaseUrl: url }, jwks)).rejects.toThrow(/./);
  }
});

test("refreshing JWT issuance does not make an earlier Google authentication fresh", async () => {
  const { token, jwks } = await fixture();
  const identity = await verifyAccountToken(
    await token({
      ...google,
      email: "test@example.com",
      amr: [{ method: "oauth", timestamp: 1_700_000_000 }],
    }),
    { supabaseUrl: url },
    jwks,
  );
  expect(identity.authenticatedAtSeconds).toBe(1_700_000_000);
  expect(identity.providers).toEqual(["google"]);
});

test("admits an identity whose linked providers include Google, whichever identity is oldest", async () => {
  const { token, jwks } = await fixture();
  const identity = await verifyAccountToken(
    await token({ app_metadata: { provider: "github", providers: ["github", "google"] } }),
    { supabaseUrl: url },
    jwks,
  );
  expect(identity.providers).toEqual(["google"]);
});

test("admits an Apple-first identity and counts its OAuth sign-in as fresh authentication", async () => {
  const { token, jwks } = await fixture();
  const identity = await verifyAccountToken(
    await token({
      app_metadata: { provider: "apple", providers: ["apple"] },
      amr: [{ method: "oauth", timestamp: 1_700_000_000 }],
    }),
    { supabaseUrl: url },
    jwks,
  );
  expect(identity.providers).toEqual(["apple"]);
  expect(identity.authenticatedAtSeconds).toBe(1_700_000_000);
});

test("carries both providers of an identity linked to Google and Apple", async () => {
  const { token, jwks } = await fixture();
  const identity = await verifyAccountToken(
    await token({ app_metadata: { provider: "google", providers: ["google", "apple"] } }),
    { supabaseUrl: url },
    jwks,
  );
  expect(identity.providers).toEqual(["google", "apple"]);
});

test("rejects identities of providers other than Google or Apple outside local development", async () => {
  const { token, jwks } = await fixture();
  for (const claims of [
    {},
    { app_metadata: { provider: "github", providers: ["github"] } },
    { app_metadata: { provider: "google" } },
    { app_metadata: { provider: "google", providers: "google" } },
    { app_metadata: { provider: "email", providers: ["email"] }, email: testAccountEmail },
  ]) {
    await expect(
      verifyAccountToken(await token(claims), { supabaseUrl: url }, jwks),
    ).rejects.toThrow(/provider/);
  }
});

test("accepts only the configured local test account among email identities", async () => {
  const { token, jwks } = await fixture();
  const options = { supabaseUrl: url, testAccountEmail };
  const identity = await verifyAccountToken(
    await token({
      app_metadata: { provider: "email", providers: ["email"] },
      email: testAccountEmail,
      amr: [{ method: "password", timestamp: 1_700_000_000 }],
    }),
    options,
    jwks,
  );
  expect(identity.providers).toEqual(["test-account"]);
  expect(identity.authenticatedAtSeconds).toBe(1_700_000_000);
  await expect(
    verifyAccountToken(
      await token({
        app_metadata: { provider: "email", providers: ["email"] },
        email: "other@cup.local",
      }),
      options,
      jwks,
    ),
  ).rejects.toThrow(/provider/);
});

test("fresh authentication counts only the method of the identity's own provider", async () => {
  const { token, jwks } = await fixture();
  const options = { supabaseUrl: url, testAccountEmail };
  const googleWithPassword = await verifyAccountToken(
    await token({ ...google, amr: [{ method: "password", timestamp: 1_700_000_000 }] }),
    options,
    jwks,
  );
  expect(googleWithPassword.authenticatedAtSeconds).toBe(0);
  const testAccountWithOauth = await verifyAccountToken(
    await token({
      app_metadata: { provider: "email", providers: ["email"] },
      email: testAccountEmail,
      amr: [{ method: "oauth", timestamp: 1_700_000_000 }],
    }),
    options,
    jwks,
  );
  expect(testAccountWithOauth.authenticatedAtSeconds).toBe(0);
});
