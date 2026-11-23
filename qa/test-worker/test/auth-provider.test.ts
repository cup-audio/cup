import crypto from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { setTimeout } from "node:timers/promises";
import { Temporal } from "temporal-polyfill";
import { afterAll, beforeAll, expect, test } from "vitest";

import { APPLE_SIGN_IN_KEY } from "#src/apple-sign-in-key.ts";
import { startAuthProvider, TEST_ACCOUNT, type AuthProvider } from "#src/auth-provider.ts";

let sharedAuthProvider: AuthProvider | undefined;

beforeAll(async () => {
  sharedAuthProvider = await startAuthProvider({ hostname: "localhost" });
});

afterAll(async () => {
  await sharedAuthProvider?.close();
});

test("is reachable at localhost over IPv4 and IPv6 and issues its tokens there", async () => {
  const { origin } = startedAuthProvider();
  expect(origin).toMatch(/^http:\/\/localhost:\d+$/);
  const { port } = new URL(origin);
  for (const loopback of ["127.0.0.1", "[::1]"]) {
    const response = await fetch(`http://${loopback}:${port}/auth/v1/.well-known/jwks.json`);
    expect(response.status).toBe(200);
  }

  const session = await exchangeIdToken(await googleIdToken(hash("the nonce")), "the nonce");
  expect(session.status).toBe(200);
  expect(issuerOf(await session.json())).toBe(`${origin}/auth/v1`);
});

test("rejects an ID token exchange whose nonce does not match the token's", async () => {
  const idToken = await googleIdToken(hash("the nonce"));

  const response = await exchangeIdToken(idToken, "another nonce");

  expect(response.status).toBe(400);
});

test.each(["audio.cup.app://auth/callback", "http://127.0.0.1:5173/app/"])(
  "sends a PKCE authorization's code to %s, where it exchanges for a session",
  async (redirect) => {
    const verifier = "the code verifier";

    const response = await authorize(redirect, hashForPkce(verifier));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.href.startsWith(redirect)).toBe(true);
    const session = await fetch(`${startedAuthProvider().origin}/auth/v1/token?grant_type=pkce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_code: location.searchParams.get("code"),
        code_verifier: verifier,
      }),
    });
    expect(session.status).toBe(200);
  },
);

test.each(["audio.cup.app://share", "https://attacker.example/auth/callback"])(
  "refuses a PKCE authorization that redirects to %s",
  async (redirect) => {
    const response = await authorize(redirect, hashForPkce("the code verifier"));

    expect(response.status).toBe(400);
  },
);

test.each(["pkce", "id_token"] as const)(
  "exchanges the refresh token of a %s session for a new session signed with the provider's key",
  async (grant) => {
    const { refresh_token: refreshToken } = await signIn(grant);

    const session = await sessionOf(await refresh(refreshToken));

    expect(await verifiesAgainstJwks(session.access_token)).toBe(true);
    expect(session.refresh_token).not.toBe(refreshToken);
  },
);

test.each(["pkce", "id_token"] as const)(
  "a %s session lists Google among the linked providers, as Supabase does",
  async (grant) => {
    const session = await signIn(grant);

    expect(claimsOf(session.access_token)).toMatchObject({
      app_metadata: { provider: "google", providers: ["google"] },
    });
  },
);

test("signs in the local test account with its password, as an email-provider session", async () => {
  const response = await exchangePassword(TEST_ACCOUNT);

  expect(response.status).toBe(200);
  const session = await sessionOf(response);
  expect(await verifiesAgainstJwks(session.access_token)).toBe(true);
  expect(claimsOf(session.access_token)).toMatchObject({
    email: TEST_ACCOUNT.email,
    app_metadata: { provider: "email", providers: ["email"] },
    amr: [{ method: "password" }],
  });
  const refreshed = await sessionOf(await refresh(session.refresh_token));
  expect(claimsOf(refreshed.access_token)).toMatchObject({
    sub: claimsOf(session.access_token)["sub"],
    app_metadata: { provider: "email", providers: ["email"] },
  });
});

test("rejects a password sign-in with other credentials, as Supabase does", async () => {
  const response = await exchangePassword({ ...TEST_ACCOUNT, password: "another password" });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    code: "invalid_credentials",
    message: "Invalid login credentials",
  });
});

test("returns the same session for a refresh token reused within the reuse interval, as Supabase does", async () => {
  const { refresh_token: refreshToken } = await signIn("pkce");
  const refreshed = await sessionOf(await refresh(refreshToken));
  const refreshesBefore = startedAuthProvider().refreshes();

  const reused = await sessionOf(await refresh(refreshToken));

  expect(reused).toEqual(refreshed);
  expect(startedAuthProvider().refreshes()).toBe(refreshesBefore);
});

test("rejects a refresh token reused after the reuse interval, as Supabase does", async () => {
  const authProvider = await startAuthProvider();
  try {
    authProvider.setRefreshTokenReuseInterval(0.05);
    const { origin } = authProvider;
    const idToken = await googleIdToken(hash("the nonce"), origin);
    const session = await sessionOf(await exchangeIdToken(idToken, "the nonce", origin));
    await sessionOf(await refresh(session.refresh_token, origin));
    await setTimeout(100);

    const response = await refresh(session.refresh_token, origin);

    expect(response.status).toBe(400);
    expect(response.headers.get("x-supabase-api-version")).toBe("2024-01-01");
    expect(await response.json()).toEqual({
      code: "refresh_token_already_used",
      message: "Invalid Refresh Token: Already Used",
    });
  } finally {
    await authProvider.close();
  }
});

test("refuses a negative refresh token reuse interval", () => {
  expect(() => startedAuthProvider().setRefreshTokenReuseInterval(-1)).toThrow(
    "A refresh token reuse interval must be a non-negative number of seconds: -1",
  );
});

test("rejects a refresh token it never issued, as Supabase does", async () => {
  const response = await refresh("an unknown refresh token");

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    code: "refresh_token_not_found",
    message: "Invalid Refresh Token: Refresh Token Not Found",
  });
});

test("answers a client without an API version with Supabase's legacy error shape", async () => {
  const response = await fetch(
    `${startedAuthProvider().origin}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: "an unknown refresh token" }),
    },
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    code: 400,
    error_code: "refresh_token_not_found",
    msg: "Invalid Refresh Token: Refresh Token Not Found",
  });
});

test("lets a browser read the API version of an error response", async () => {
  const response = await refresh("an unknown refresh token");

  expect(response.headers.get("access-control-expose-headers")).toContain("X-Supabase-Api-Version");
});

test("in hold mode, an authorization shows a page whose Continue link carries the redirect with the code", async () => {
  const authProvider = await startAuthProvider();
  try {
    authProvider.holdAuthorizations();

    const response = await authorize("audio.cup.app://auth/callback", hashForPkce("verifier"), {
      provider: "apple",
      origin: authProvider.origin,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const continueLink = /<a id="continue" href="([^"]+)">Continue<\/a>/u.exec(
      await response.text(),
    );
    const location = new URL((continueLink?.[1] ?? "").replaceAll("&amp;", "&"));
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe(
      "audio.cup.app://auth/callback",
    );
    expect(location.searchParams.get("code")).toMatch(/\S/u);
  } finally {
    await authProvider.close();
  }
});

test("closes while a browser still holds open connections to it", async () => {
  const authProvider = await startAuthProvider();
  authProvider.holdAuthorizations();
  const { port } = new URL(authProvider.origin);
  const idleSocket = net.connect(Number(port), "127.0.0.1");
  await once(idleSocket, "connect");
  const closedSocket = once(idleSocket, "close");
  await authorize("audio.cup.app://auth/callback", hashForPkce("verifier"), {
    provider: "apple",
    origin: authProvider.origin,
  });

  const closed = await Promise.race([
    authProvider.close().then(() => "closed"),
    setTimeout(2_000, "still open"),
  ]);

  expect(closed).toBe("closed");
  await closedSocket;
});

test("records the query parameters of every authorization request, in order", async () => {
  const authProvider = await startAuthProvider();
  try {
    for (const query of [
      { provider: "google", prompt: "select_account", max_age: "0" },
      { provider: "google", redirect_to: "https://attacker.example/" },
    ]) {
      const url = new URL(`${authProvider.origin}/auth/v1/authorize`);
      url.search = new URLSearchParams(query).toString();
      await fetch(url, { redirect: "manual" });
    }

    expect(authProvider.authorizationRequests()).toEqual([
      { provider: "google", prompt: "select_account", max_age: "0" },
      { provider: "google", redirect_to: "https://attacker.example/" },
    ]);
  } finally {
    await authProvider.close();
  }
});

test("an Apple sign-in creates a user that lists Apple as its provider and returns Apple's refresh token", async () => {
  const authProvider = await startAuthProvider();
  try {
    const session = await signInWithProvider("apple", authProvider.origin);

    expect(claimsOf(session.access_token)).toMatchObject({
      email: "reader@example.test",
      app_metadata: { provider: "apple", providers: ["apple"] },
      amr: [{ method: "oauth" }],
    });
    expect(session.provider_refresh_token).toEqual(expect.any(String));
  } finally {
    await authProvider.close();
  }
});

test("an Apple sign-in with a Google user's email lands in that user and links both providers, as Supabase does", async () => {
  const authProvider = await startAuthProvider();
  try {
    const google = await signInWithProvider("google", authProvider.origin);
    const apple = await signInWithProvider("apple", authProvider.origin);

    expect(google.provider_refresh_token).toBeUndefined();
    expect(claimsOf(apple.access_token)).toMatchObject({
      sub: claimsOf(google.access_token)["sub"],
      app_metadata: { provider: "google", providers: ["google", "apple"] },
    });
    const refreshed = await sessionOf(await refresh(google.refresh_token, authProvider.origin));
    expect(claimsOf(refreshed.access_token)).toMatchObject({
      app_metadata: { providers: ["google", "apple"] },
    });
  } finally {
    await authProvider.close();
  }
});

test("an Apple sign-in through Hide My Email is a user of its own that the admin API knows", async () => {
  const authProvider = await startAuthProvider();
  try {
    const google = await signInWithProvider("google", authProvider.origin);
    authProvider.setAppleEmail("qa-relay@privaterelay.appleid.com");

    const apple = await signInWithProvider("apple", authProvider.origin);

    const claims = claimsOf(apple.access_token);
    expect(claims).toMatchObject({
      email: "qa-relay@privaterelay.appleid.com",
      app_metadata: { provider: "apple", providers: ["apple"] },
    });
    expect(claims["sub"]).not.toBe(claimsOf(google.access_token)["sub"]);
    const user = await fetch(
      `${authProvider.origin}/auth/v1/admin/users/${String(claims["sub"])}`,
      { headers: { Authorization: "Bearer qa-admin" } },
    );
    expect(user.status).toBe(200);
  } finally {
    await authProvider.close();
  }
});

test("a native Apple sign-in exchanges the sheet's identity token and raw nonce for an Apple session", async () => {
  const authProvider = await startAuthProvider();
  try {
    const { origin } = authProvider;
    const apple = await appleCredential(hash("the nonce"), origin);

    const session = await sessionOf(
      await exchangeIdToken(apple.identityToken, "the nonce", origin, "apple"),
    );

    expect(claimsOf(apple.identityToken)).toMatchObject({
      iss: "https://appleid.apple.com",
      aud: "audio.cup.app",
      nonce: hash("the nonce"),
      email: "reader@example.test",
    });
    expect(apple.authorizationCode).toEqual(expect.any(String));
    expect(claimsOf(session.access_token)).toMatchObject({
      email: "reader@example.test",
      app_metadata: { provider: "apple", providers: ["apple"] },
      amr: [{ method: "id_token" }],
    });
  } finally {
    await authProvider.close();
  }
});

test("a native Apple sign-in issues its identity token for the email a test sets", async () => {
  const authProvider = await startAuthProvider();
  try {
    authProvider.setAppleEmail("qa-relay@privaterelay.appleid.com");
    const { origin } = authProvider;
    const apple = await appleCredential(hash("the nonce"), origin);

    const session = await sessionOf(
      await exchangeIdToken(apple.identityToken, "the nonce", origin, "apple"),
    );

    expect(claimsOf(session.access_token)).toMatchObject({
      email: "qa-relay@privaterelay.appleid.com",
    });
  } finally {
    await authProvider.close();
  }
});

test("rejects a native Apple sign-in whose raw nonce does not hash to the identity token's", async () => {
  const { identityToken } = await appleCredential(hash("the nonce"));

  const response = await exchangeIdToken(identityToken, "another nonce", undefined, "apple");

  expect(response.status).toBe(400);
});

test("rejects an Apple identity token exchanged as Google's, and Google's as Apple's", async () => {
  const { identityToken } = await appleCredential(hash("the nonce"));
  const googleToken = await googleIdToken(hash("the nonce"));

  const asGoogle = await exchangeIdToken(identityToken, "the nonce", undefined, "google");
  const asApple = await exchangeIdToken(googleToken, "the nonce", undefined, "apple");

  expect(asGoogle.status).toBe(400);
  expect(asApple.status).toBe(400);
});

test("stands in for Apple: validates a web sign-in's refresh token with the linked Apple subject, then revokes it", async () => {
  const authProvider = await startAuthProvider();
  try {
    const apple = await signInWithProvider("apple", authProvider.origin);
    const refreshToken = apple.provider_refresh_token ?? "";
    const user = await adminUser(authProvider.origin, String(claimsOf(apple.access_token)["sub"]));

    const validated = await postToApple(authProvider.origin, "/auth/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    expect(validated.status).toBe(200);
    expect(claimsOf(await idTokenOf(validated))["sub"]).toBe(appleSubjectOf(user));
    const revoked = await postToApple(authProvider.origin, "/auth/revoke", {
      token: refreshToken,
      token_type_hint: "refresh_token",
    });
    expect(revoked.status).toBe(200);

    expect(authProvider.appleRequests()).toStrictEqual([
      {
        path: "/auth/token",
        clientId: "audio.cup.app.web",
        grantType: "refresh_token",
        token: refreshToken,
        atMs: expect.any(Number),
      },
      {
        path: "/auth/revoke",
        clientId: "audio.cup.app.web",
        tokenTypeHint: "refresh_token",
        token: refreshToken,
        atMs: expect.any(Number),
      },
    ]);
    const afterRevocation = await postToApple(authProvider.origin, "/auth/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    expect(afterRevocation.status).toBe(400);
  } finally {
    await authProvider.close();
  }
});

test("stands in for Apple: exchanges a native sign-in's authorization code once, as the app, for a refresh token it can revoke", async () => {
  const authProvider = await startAuthProvider();
  try {
    const { origin } = authProvider;
    const credential = await appleCredential(hash("the nonce"), origin);
    const session = await sessionOf(
      await exchangeIdToken(credential.identityToken, "the nonce", origin, "apple"),
    );
    const user = await adminUser(origin, String(claimsOf(session.access_token)["sub"]));
    const exchangeCode = () =>
      postToApple(
        origin,
        "/auth/token",
        { grant_type: "authorization_code", code: credential.authorizationCode },
        undefined,
        "audio.cup.app",
      );

    const exchanged = await exchangeCode();
    expect(exchanged.status).toBe(200);
    const tokens: unknown = await exchanged.json();
    if (!isRecord(tokens) || typeof tokens["refresh_token"] !== "string") {
      throw new Error("Apple returned no refresh token.");
    }
    expect(claimsOf(String(tokens["id_token"]))).toMatchObject({
      aud: "audio.cup.app",
      sub: appleSubjectOf(user),
    });
    const revoked = await postToApple(
      origin,
      "/auth/revoke",
      { token: tokens["refresh_token"], token_type_hint: "refresh_token" },
      undefined,
      "audio.cup.app",
    );
    expect(revoked.status).toBe(200);
    const reused = await exchangeCode();
    expect(reused.status).toBe(400);
    expect(await reused.json()).toStrictEqual({ error: "invalid_grant" });

    expect(authProvider.appleRequests()).toStrictEqual([
      {
        path: "/auth/token",
        clientId: "audio.cup.app",
        grantType: "authorization_code",
        token: credential.authorizationCode,
        atMs: expect.any(Number),
      },
      {
        path: "/auth/revoke",
        clientId: "audio.cup.app",
        tokenTypeHint: "refresh_token",
        token: tokens["refresh_token"],
        atMs: expect.any(Number),
      },
      {
        path: "/auth/token",
        clientId: "audio.cup.app",
        grantType: "authorization_code",
        token: credential.authorizationCode,
        atMs: expect.any(Number),
      },
    ]);
  } finally {
    await authProvider.close();
  }
});

test("refuses a native authorization code that a test expired or that another client exchanges", async () => {
  const authProvider = await startAuthProvider();
  try {
    const { origin } = authProvider;
    const expired = await appleCredential(hash("the nonce"), origin);
    authProvider.expireAppleAuthorizationCodes();
    const fresh = await appleCredential(hash("the nonce"), origin);

    const asApp = (code: string) =>
      postToApple(
        origin,
        "/auth/token",
        { grant_type: "authorization_code", code },
        undefined,
        "audio.cup.app",
      );
    const asWeb = await postToApple(origin, "/auth/token", {
      grant_type: "authorization_code",
      code: fresh.authorizationCode,
    });

    expect((await asApp(expired.authorizationCode)).status).toBe(400);
    expect(asWeb.status).toBe(400);
    expect((await asApp(fresh.authorizationCode)).status).toBe(200);
  } finally {
    await authProvider.close();
  }
});

test("refuses Apple requests whose client secret the test Worker's key did not sign", async () => {
  const authProvider = await startAuthProvider();
  try {
    const apple = await signInWithProvider("apple", authProvider.origin);
    const forgedKey = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;

    const response = await postToApple(
      authProvider.origin,
      "/auth/token",
      { grant_type: "refresh_token", refresh_token: apple.provider_refresh_token ?? "" },
      forgedKey,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({ error: "invalid_client" });
  } finally {
    await authProvider.close();
  }
});

test("lets a test make Apple fail a step or answer with another Apple Account's subject", async () => {
  const authProvider = await startAuthProvider();
  try {
    const apple = await signInWithProvider("apple", authProvider.origin);
    const validate = () =>
      postToApple(authProvider.origin, "/auth/token", {
        grant_type: "refresh_token",
        refresh_token: apple.provider_refresh_token ?? "",
      });
    const revoke = () =>
      postToApple(authProvider.origin, "/auth/revoke", {
        token: apple.provider_refresh_token ?? "",
        token_type_hint: "refresh_token",
      });

    authProvider.setAppleFailure("/auth/token");
    expect((await validate()).status).toBe(400);
    authProvider.setAppleFailure("/auth/revoke");
    expect((await validate()).status).toBe(200);
    expect((await revoke()).status).toBe(503);
    authProvider.setAppleFailure(undefined);
    authProvider.setAppleTokenSubject("000999.other-apple.0789");
    expect(claimsOf(await idTokenOf(await validate()))["sub"]).toBe("000999.other-apple.0789");
    expect(authProvider.appleRequests().map(({ path }) => path)).toStrictEqual([
      "/auth/token",
      "/auth/token",
      "/auth/revoke",
      "/auth/token",
    ]);
  } finally {
    await authProvider.close();
  }
});

test("issues access tokens for 300 seconds by default", async () => {
  const session = await signIn("pkce");

  expect(session.expires_in).toBe(300);
  expect(lifetimeOf(session.access_token)).toBe(300);
});

test("issues access tokens for the lifetime a test sets, also on refresh", async () => {
  const authProvider = await startAuthProvider();
  try {
    authProvider.setAccessTokenLifetime(5);
    const { origin } = authProvider;
    const idToken = await googleIdToken(hash("the nonce"), origin);
    const session = await sessionOf(await exchangeIdToken(idToken, "the nonce", origin));
    const refreshed = await sessionOf(await refresh(session.refresh_token, origin));

    for (const { expires_in: expiresIn, access_token: accessToken } of [session, refreshed]) {
      expect(expiresIn).toBe(5);
      expect(lifetimeOf(accessToken)).toBe(5);
    }
  } finally {
    await authProvider.close();
  }
});

function authorize(
  redirect: string,
  challenge: string,
  { provider = "google", origin = startedAuthProvider().origin } = {},
): Promise<Response> {
  const url = new URL(`${origin}/auth/v1/authorize`);
  url.search = new URLSearchParams({
    provider,
    redirect_to: redirect,
    code_challenge: challenge,
    code_challenge_method: "s256",
  }).toString();
  return fetch(url, { redirect: "manual" });
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function adminUser(origin: string, id: string): Promise<unknown> {
  const response = await fetch(`${origin}/auth/v1/admin/users/${id}`, {
    headers: { Authorization: "Bearer qa-admin" },
  });
  return response.json();
}

function appleSubjectOf(user: unknown): unknown {
  if (!isRecord(user) || !Array.isArray(user["identities"])) {
    throw new Error("The admin API returned no identities.");
  }
  const apple: unknown = user["identities"].find(
    (identity: unknown) => isRecord(identity) && identity["provider"] === "apple",
  );
  return isRecord(apple) && isRecord(apple["identity_data"])
    ? apple["identity_data"]["sub"]
    : undefined;
}

async function idTokenOf(response: Response): Promise<string> {
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body["id_token"] !== "string") {
    throw new Error("Apple returned no ID token.");
  }
  return body["id_token"];
}

function postToApple(
  origin: string,
  path: "/auth/token" | "/auth/revoke",
  form: Record<string, string>,
  key: crypto.KeyObject = crypto.createPrivateKey(APPLE_SIGN_IN_KEY.privateKey),
  clientId = "audio.cup.app.web",
): Promise<Response> {
  const now = Math.floor(Temporal.Now.instant().epochMilliseconds / 1000);
  const message = `${encode({ alg: "ES256", kid: APPLE_SIGN_IN_KEY.keyId })}.${encode({
    iss: APPLE_SIGN_IN_KEY.teamId,
    aud: "https://appleid.apple.com",
    sub: clientId,
    iat: now,
    exp: now + 300,
  })}`;
  const signature = crypto
    .sign("sha256", Buffer.from(message), { key, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: `${message}.${signature}`,
      ...form,
    }),
  });
}

function hashForPkce(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function startedAuthProvider() {
  if (sharedAuthProvider === undefined) {
    throw new Error("The fake auth provider has not started.");
  }
  return sharedAuthProvider;
}

async function googleIdToken(
  hashedNonce: string,
  origin = startedAuthProvider().origin,
): Promise<string> {
  const response = await fetch(`${origin}/qa/google-id-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce: hashedNonce }),
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body["idToken"] !== "string") {
    throw new Error("The fake auth provider returned no ID token.");
  }
  return body["idToken"];
}

async function appleCredential(
  hashedNonce: string,
  origin = startedAuthProvider().origin,
): Promise<{ identityToken: string; authorizationCode: string }> {
  const response = await fetch(`${origin}/qa/apple-credential`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce: hashedNonce }),
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    typeof body["identityToken"] !== "string" ||
    typeof body["authorizationCode"] !== "string"
  ) {
    throw new Error("The fake auth provider returned no Apple credential.");
  }
  return { identityToken: body["identityToken"], authorizationCode: body["authorizationCode"] };
}

function exchangeIdToken(
  idToken: string,
  nonce: string,
  origin = startedAuthProvider().origin,
  provider: "google" | "apple" = "google",
): Promise<Response> {
  return fetch(`${origin}/auth/v1/token?grant_type=id_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, id_token: idToken, nonce }),
  });
}

function exchangePassword(credentials: { email: string; password: string }): Promise<Response> {
  return fetch(`${startedAuthProvider().origin}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Supabase-Api-Version": "2024-01-01" },
    body: JSON.stringify(credentials),
  });
}

function claimsOf(accessToken: string): Record<string, unknown> {
  const payload: unknown = JSON.parse(
    Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString(),
  );
  if (!isRecord(payload)) {
    throw new Error("The access token has no claims.");
  }
  return payload;
}

function hash(nonce: string): string {
  return crypto.createHash("sha256").update(nonce).digest("hex");
}

function lifetimeOf(accessToken: string): unknown {
  const payload: unknown = JSON.parse(
    Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString(),
  );
  if (
    !isRecord(payload) ||
    typeof payload["iat"] !== "number" ||
    typeof payload["exp"] !== "number"
  ) {
    throw new Error("The access token has no lifetime.");
  }
  return payload["exp"] - payload["iat"];
}

function issuerOf(session: unknown): unknown {
  if (!isRecord(session) || typeof session["access_token"] !== "string") {
    throw new Error("The exchange returned no access token.");
  }
  const payload: unknown = JSON.parse(
    Buffer.from(session["access_token"].split(".")[1] ?? "", "base64url").toString(),
  );
  return isRecord(payload) ? payload["iss"] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type Session = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  provider_refresh_token?: string;
};

async function signIn(grant: "pkce" | "id_token"): Promise<Session> {
  if (grant === "id_token") {
    return sessionOf(await exchangeIdToken(await googleIdToken(hash("the nonce")), "the nonce"));
  }
  return signInWithProvider("google", startedAuthProvider().origin);
}

async function signInWithProvider(provider: "google" | "apple", origin: string): Promise<Session> {
  const verifier = "the code verifier";
  const authorization = await authorize("http://127.0.0.1:5173/app/", hashForPkce(verifier), {
    provider,
    origin,
  });
  const code = new URL(authorization.headers.get("location") ?? "").searchParams.get("code");
  return sessionOf(
    await fetch(`${origin}/auth/v1/token?grant_type=pkce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
    }),
  );
}

function refresh(refreshToken: string, origin = startedAuthProvider().origin): Promise<Response> {
  return fetch(`${origin}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Supabase-Api-Version": "2024-01-01" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

async function sessionOf(response: Response): Promise<Session> {
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (
    !isRecord(body) ||
    typeof body["access_token"] !== "string" ||
    typeof body["refresh_token"] !== "string" ||
    typeof body["expires_in"] !== "number"
  ) {
    throw new Error("The provider returned no session.");
  }
  return {
    access_token: body["access_token"],
    refresh_token: body["refresh_token"],
    expires_in: body["expires_in"],
    ...(typeof body["provider_refresh_token"] === "string"
      ? { provider_refresh_token: body["provider_refresh_token"] }
      : {}),
  };
}

async function verifiesAgainstJwks(token: string): Promise<boolean> {
  const response = await fetch(`${startedAuthProvider().origin}/auth/v1/.well-known/jwks.json`);
  const jwks: unknown = await response.json();
  if (!isRecord(jwks) || !Array.isArray(jwks["keys"]) || !isRecord(jwks["keys"][0])) {
    throw new Error("The provider published no key.");
  }
  const key = crypto.createPublicKey({ key: jwks["keys"][0], format: "jwk" });
  const [header = "", payload = "", signature = ""] = token.split(".");
  return crypto.verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
}
