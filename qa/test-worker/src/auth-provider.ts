import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { Temporal } from "temporal-polyfill";

import { createFakeApple, type AppleEndpoint } from "#src/fake-apple.ts";

const SUBJECT = "880ce5b5-6542-40fd-8f2d-380f3066e98a";
const READER_NAME = "Reader Doe";
const OTHER_SUBJECT = "70fcf2d9-63c5-48be-b897-d3670f24ed43";
const GOOGLE_ISSUER = "https://accounts.google.com";
const GOOGLE_SUBJECT = "qa-google";
const APPLE_SUBJECT = "000123.qa-apple.0456";
const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_NATIVE_CLIENT_ID = "audio.cup.app";
const READER_EMAIL = "reader@example.test";
const IOS_AUTH_CALLBACK_URL = "audio.cup.app://auth/callback";
const SUPABASE_API_VERSION = "2024-01-01";
const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 300;
const DEFAULT_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS = 10;
export const TEST_ACCOUNT = { email: "test-account@example.test", password: "qa-test-account" };
const TEST_ACCOUNT_SUBJECT = "c5a2b1e4-0f3d-4b8e-9a6c-2d7e1f4b9a30";
const nowMilliseconds = () => Temporal.Now.instant().epochMilliseconds;
const nowSeconds = () => Math.floor(nowMilliseconds() / 1000);

type StartAuthProviderOptions = {
  hostname?: "127.0.0.1" | "localhost";
  tls?: { key: Buffer; cert: Buffer };
};

export type AuthProvider = Awaited<ReturnType<typeof startAuthProvider>>;

type OAuthProvider = "google" | "apple";

type User = {
  id: string;
  email: string;
  providers: Array<OAuthProvider | "email">;
  metadata: Record<string, string>;
};

type SignIn = {
  userId: string;
  authenticatedAt: number;
  method: "oauth" | "id_token" | "password";
};

type Rotation = { session: string; rotatedAt: number };

export async function startAuthProvider(options: StartAuthProviderOptions = {}) {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = {
    ...pair.publicKey.export({ format: "jwk" }),
    kid: "qa-key",
    alg: "ES256",
    use: "sig",
  };
  const codes = new Map<
    string,
    { challenge: string; authenticatedAt: number; provider: OAuthProvider }
  >();
  const testAccountUser: User = {
    id: TEST_ACCOUNT_SUBJECT,
    email: TEST_ACCOUNT.email,
    providers: ["email"],
    metadata: {},
  };
  const users: User[] = [testAccountUser];
  let appleEmail = READER_EMAIL;
  const refreshTokens = new Map<string, SignIn & { rotation?: Rotation }>();
  const authorizationRequests: Array<Record<string, string>> = [];
  let origin = "";
  let exchanges = 0;
  let refreshes = 0;
  let accessTokenLifetimeSeconds = DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS;
  let refreshTokenReuseIntervalSeconds = DEFAULT_REFRESH_TOKEN_REUSE_INTERVAL_SECONDS;
  const sign = (claims: Record<string, unknown>) => {
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "qa-key" })).toString(
      "base64url",
    );
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const message = `${header}.${payload}`;
    return `${message}.${crypto.sign("sha256", Buffer.from(message), { key: pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  const verify = (token: string): Record<string, unknown> | undefined => {
    const [header, payload, signature] = token.split(".");
    if (
      header === undefined ||
      payload === undefined ||
      signature === undefined ||
      !crypto.verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key: pair.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      )
    ) {
      return undefined;
    }
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString());
    return claims && typeof claims === "object" ? { ...claims } : undefined;
  };
  const apple = createFakeApple({ signIdToken: sign });
  const tokenFor = (
    user: Pick<User, "id" | "email" | "providers">,
    authenticatedAt = nowSeconds(),
    method: SignIn["method"] = "oauth",
  ) => {
    const now = nowSeconds();
    return sign({
      iss: `${origin}/auth/v1`,
      sub: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      iat: now,
      exp: now + accessTokenLifetimeSeconds,
      app_metadata: { provider: user.providers[0], providers: [...user.providers] },
      amr: [{ method, timestamp: authenticatedAt }],
    });
  };
  const userSignedInWith = (provider: OAuthProvider): User => {
    const email = provider === "apple" ? appleEmail : READER_EMAIL;
    const existing = users.find((user) => user.email === email);
    if (existing) {
      if (!existing.providers.includes(provider)) {
        existing.providers.push(provider);
      }
      return existing;
    }
    const user: User = {
      id: email === READER_EMAIL ? SUBJECT : crypto.randomUUID(),
      email,
      providers: [provider],
      metadata: provider === "google" ? { name: READER_NAME, full_name: READER_NAME } : {},
    };
    users.push(user);
    return user;
  };
  const requireUser = (id: string) => {
    const user = users.find((candidate) => candidate.id === id);
    if (!user) {
      throw new Error(`Unknown QA user ${id}`);
    }
    return user;
  };
  const sessionFor = (
    { userId, authenticatedAt, method }: SignIn,
    providerTokens: { provider_refresh_token?: string } = {},
  ) => {
    const refreshToken = crypto.randomUUID();
    refreshTokens.set(refreshToken, { userId, authenticatedAt, method });
    const user = requireUser(userId);

    return JSON.stringify({
      access_token: tokenFor(user, authenticatedAt, method),
      token_type: "bearer",
      refresh_token: refreshToken,
      expires_in: accessTokenLifetimeSeconds,
      ...providerTokens,
      user: {
        id: user.id,
        email: user.email,
        aud: "authenticated",
        app_metadata: { provider: user.providers[0], providers: [...user.providers] },
        user_metadata: user.metadata,
        identities: user.providers.map((provider) => ({
          provider,
          identity_data: { sub: identitySubjectOf(user, provider) },
        })),
      },
    });
  };
  const authorize = (url: URL, response: http.ServerResponse) => {
    authorizationRequests.push(Object.fromEntries(url.searchParams));
    const redirect = new URL(url.searchParams.get("redirect_to") ?? "");
    const provider = url.searchParams.get("provider");
    if (
      (provider !== "google" && provider !== "apple") ||
      url.searchParams.get("code_challenge_method")?.toLowerCase() !== "s256" ||
      !isAllowedRedirect(redirect)
    ) {
      throw new Error("Invalid QA OAuth request");
    }
    const code = crypto.randomUUID();
    codes.set(code, {
      challenge: url.searchParams.get("code_challenge") ?? "",
      authenticatedAt: nowSeconds(),
      provider,
    });
    redirect.searchParams.set("code", code);
    response.writeHead(302, { Location: redirect.href }).end();
  };
  const issueGoogleIdToken = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || !("nonce" in body) || typeof body.nonce !== "string") {
      throw new Error("Invalid QA Google ID token request");
    }
    const now = nowSeconds();
    response.end(
      JSON.stringify({
        idToken: sign({
          iss: GOOGLE_ISSUER,
          aud: "qa-google-client",
          sub: GOOGLE_SUBJECT,
          email: "reader@example.test",
          name: READER_NAME,
          nonce: body.nonce,
          iat: now,
          exp: now + 300,
        }),
        userId: GOOGLE_SUBJECT,
        email: "reader@example.test",
        displayName: READER_NAME,
      }),
    );
  };
  const issueAppleCredential = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || !("nonce" in body) || typeof body.nonce !== "string") {
      throw new Error("Invalid QA Apple credential request");
    }
    const now = nowSeconds();
    const email = appleEmail;
    response.end(
      JSON.stringify({
        identityToken: sign({
          iss: APPLE_ISSUER,
          aud: APPLE_NATIVE_CLIENT_ID,
          sub: APPLE_SUBJECT,
          email,
          nonce: body.nonce,
          iat: now,
          exp: now + 300,
        }),
        authorizationCode: apple.issueAuthorizationCode(() => {
          const user = users.find((candidate) => candidate.email === email);
          return user === undefined ? APPLE_SUBJECT : identitySubjectOf(user, "apple");
        }),
      }),
    );
  };
  const exchange = async (
    url: URL,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => {
    const body = await readJson(request);
    if (url.searchParams.get("grant_type") === "id_token") {
      exchangeIdToken(body, response);
      return;
    }
    if (url.searchParams.get("grant_type") === "refresh_token") {
      exchangeRefreshToken(body, request, response);
      return;
    }
    if (url.searchParams.get("grant_type") === "password") {
      exchangePassword(body, request, response);
      return;
    }
    if (
      url.searchParams.get("grant_type") !== "pkce" ||
      !body ||
      typeof body !== "object" ||
      !("auth_code" in body) ||
      typeof body.auth_code !== "string" ||
      !("code_verifier" in body) ||
      typeof body.code_verifier !== "string"
    ) {
      throw new Error("Invalid PKCE exchange");
    }
    const code = codes.get(body.auth_code);
    if (
      !code ||
      crypto.createHash("sha256").update(body.code_verifier).digest("base64url") !== code.challenge
    ) {
      throw new Error("PKCE verification failed");
    }
    codes.delete(body.auth_code);
    exchanges += 1;
    const user = userSignedInWith(code.provider);
    response.end(
      sessionFor(
        { userId: user.id, authenticatedAt: code.authenticatedAt, method: "oauth" },
        code.provider === "apple"
          ? { provider_refresh_token: apple.issueRefreshToken(identitySubjectOf(user, "apple")) }
          : {},
      ),
    );
  };
  const exchangeRefreshToken = (
    body: unknown,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => {
    if (
      !body ||
      typeof body !== "object" ||
      !("refresh_token" in body) ||
      typeof body.refresh_token !== "string"
    ) {
      throw new Error("Invalid refresh token exchange");
    }
    const signIn = refreshTokens.get(body.refresh_token);
    if (signIn === undefined) {
      rejectAsSupabase(request, response, {
        errorCode: "refresh_token_not_found",
        message: "Invalid Refresh Token: Refresh Token Not Found",
      });
      return;
    }
    const { rotation } = signIn;
    if (rotation !== undefined) {
      if (nowMilliseconds() - rotation.rotatedAt <= refreshTokenReuseIntervalSeconds * 1000) {
        response.end(rotation.session);
        return;
      }

      rejectAsSupabase(request, response, {
        errorCode: "refresh_token_already_used",
        message: "Invalid Refresh Token: Already Used",
      });
      return;
    }

    const session = sessionFor(signIn);
    signIn.rotation = { session, rotatedAt: nowMilliseconds() };
    refreshes += 1;
    response.end(session);
  };
  const exchangePassword = (
    body: unknown,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => {
    if (
      !body ||
      typeof body !== "object" ||
      !("email" in body) ||
      !("password" in body) ||
      body.email !== TEST_ACCOUNT.email ||
      body.password !== TEST_ACCOUNT.password
    ) {
      rejectAsSupabase(request, response, {
        errorCode: "invalid_credentials",
        message: "Invalid login credentials",
      });
      return;
    }
    exchanges += 1;
    response.end(
      sessionFor({ userId: testAccountUser.id, authenticatedAt: nowSeconds(), method: "password" }),
    );
  };
  const exchangeIdToken = (body: unknown, response: http.ServerResponse) => {
    if (
      !body ||
      typeof body !== "object" ||
      !("provider" in body) ||
      (body.provider !== "google" && body.provider !== "apple") ||
      !("id_token" in body) ||
      typeof body.id_token !== "string" ||
      !("nonce" in body) ||
      typeof body.nonce !== "string"
    ) {
      throw new Error("Invalid ID token exchange");
    }
    const claims = verify(body.id_token);
    const { provider } = body;
    if (
      claims === undefined ||
      (provider === "google"
        ? claims["iss"] !== GOOGLE_ISSUER
        : claims["iss"] !== APPLE_ISSUER || claims["aud"] !== APPLE_NATIVE_CLIENT_ID)
    ) {
      throw new Error("ID token verification failed");
    }
    if (claims["nonce"] !== crypto.createHash("sha256").update(body.nonce).digest("hex")) {
      throw new Error("ID token nonce mismatch");
    }
    exchanges += 1;
    const user = userSignedInWith(provider);
    response.end(
      sessionFor({ userId: user.id, authenticatedAt: nowSeconds(), method: "id_token" }),
    );
  };
  const handler: http.RequestListener = (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
    );
    response.setHeader("Access-Control-Expose-Headers", "X-Supabase-Api-Version");
    response.setHeader("Content-Type", "application/json");
    const handle = async () => {
      const url = new URL(request.url ?? "/", origin);
      if (request.method === "OPTIONS") {
        response.writeHead(204).end();
        return;
      }
      if (url.pathname.endsWith("/.well-known/jwks.json")) {
        response.end(JSON.stringify({ keys: [publicKey] }));
        return;
      }
      if (url.pathname === "/auth/v1/authorize") {
        authorize(url, response);
        return;
      }
      if (url.pathname === "/qa/google-id-token" && request.method === "POST") {
        await issueGoogleIdToken(request, response);
        return;
      }
      if (url.pathname === "/qa/apple-credential" && request.method === "POST") {
        await issueAppleCredential(request, response);
        return;
      }
      if (url.pathname === "/auth/v1/token") {
        await exchange(url, request, response);
        return;
      }
      if (
        (url.pathname === "/auth/token" || url.pathname === "/auth/revoke") &&
        request.method === "POST"
      ) {
        await apple.handle(url.pathname, request, response);
        return;
      }
      if (url.pathname === "/auth/v1/logout") {
        response.writeHead(204).end();
        return;
      }
      if (
        url.pathname.startsWith("/auth/v1/admin/users/") &&
        request.headers.authorization === "Bearer qa-admin"
      ) {
        const id = url.pathname.split("/").at(-1);
        const user = users.find((candidate) => candidate.id === id);
        if (user) {
          response.end(
            JSON.stringify({
              id,
              identities: user.providers.map((provider) => ({
                provider,
                identity_data: { sub: identitySubjectOf(user, provider) },
              })),
            }),
          );
          return;
        }
        if (id === SUBJECT || id === OTHER_SUBJECT) {
          response.end(JSON.stringify({ id, identities: [] }));
          return;
        }
      }
      response.writeHead(404).end(JSON.stringify({ message: "Unknown QA identity route" }));
    };
    void handle().catch((error: unknown) => {
      response.writeHead(400).end(JSON.stringify({ message: String(error) }));
    });
  };
  const { tls } = options;
  const createServer = (): net.Server =>
    tls === undefined ? http.createServer(handler) : https.createServer(tls, handler);
  const hostname = options.hostname ?? "127.0.0.1";
  const servers =
    hostname === "localhost"
      ? await listenOnBothLoopbacks(createServer)
      : [await listen(createServer, 0, "127.0.0.1")];
  origin = `${options.tls === undefined ? "http" : "https"}://${hostname}:${portOf(servers[0])}`;
  return {
    origin,
    otherToken: () => tokenFor({ id: OTHER_SUBJECT, email: READER_EMAIL, providers: ["google"] }),
    setAppleEmail: (email: string) => {
      appleEmail = email;
    },
    authorizationRequests: () => authorizationRequests.map((query) => ({ ...query })),
    appleRequests: () => apple.requests(),
    setAppleFailure: (endpoint: AppleEndpoint | undefined) => {
      apple.setFailure(endpoint);
    },
    expireAppleAuthorizationCodes: () => {
      apple.expireAuthorizationCodes();
    },
    setAppleTokenSubject: (subject: string | undefined) => {
      apple.setTokenSubject(subject);
    },
    exchanges: () => exchanges,
    refreshes: () => refreshes,
    setAccessTokenLifetime: (seconds: number) => {
      if (!Number.isInteger(seconds) || seconds <= 0) {
        throw new Error(`An access token lifetime must be a positive whole number: ${seconds}`);
      }
      accessTokenLifetimeSeconds = seconds;
    },
    setRefreshTokenReuseInterval: (seconds: number) => {
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error(
          `A refresh token reuse interval must be a non-negative number of seconds: ${seconds}`,
        );
      }

      refreshTokenReuseIntervalSeconds = seconds;
    },
    close: async () => {
      await Promise.all(servers.map(close));
    },
  };
}

function identitySubjectOf(user: User, provider: User["providers"][number]): string {
  if (provider === "google") {
    return GOOGLE_SUBJECT;
  }
  if (provider === "apple") {
    return user.email === READER_EMAIL ? APPLE_SUBJECT : `${APPLE_SUBJECT}.${user.id}`;
  }
  return user.id;
}

function isAllowedRedirect(redirect: URL): boolean {
  return (
    redirect.hostname === "127.0.0.1" ||
    `${redirect.protocol}//${redirect.host}${redirect.pathname}` === IOS_AUTH_CALLBACK_URL
  );
}

function rejectAsSupabase(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  { errorCode, message }: { errorCode: string; message: string },
) {
  const apiVersion = request.headers["x-supabase-api-version"];
  if (typeof apiVersion === "string" && apiVersion >= SUPABASE_API_VERSION) {
    response.setHeader("X-Supabase-Api-Version", SUPABASE_API_VERSION);
    response.writeHead(400).end(JSON.stringify({ code: errorCode, message }));
    return;
  }
  response.writeHead(400).end(JSON.stringify({ code: 400, error_code: errorCode, msg: message }));
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function listenOnBothLoopbacks(createServer: () => net.Server): Promise<net.Server[]> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const ipv4 = await listen(createServer, 0, "127.0.0.1");
    try {
      return [ipv4, await listen(createServer, portOf(ipv4), "::1")];
    } catch (error) {
      await close(ipv4);
      if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) {
        throw error;
      }
    }
  }
  throw new Error("No identity port is free on both loopback addresses.");
}

function listen(createServer: () => net.Server, port: number, host: string): Promise<net.Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function portOf(server: net.Server | undefined): number {
  const address = server?.address();
  if (!address || typeof address === "string") {
    throw new Error("No identity port");
  }
  return address.port;
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
