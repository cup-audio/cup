import crypto from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { afterAll, beforeAll, expect, test } from "vitest";

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

function exchangeIdToken(
  idToken: string,
  nonce: string,
  origin = startedAuthProvider().origin,
): Promise<Response> {
  return fetch(`${origin}/auth/v1/token?grant_type=id_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "google", id_token: idToken, nonce }),
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
