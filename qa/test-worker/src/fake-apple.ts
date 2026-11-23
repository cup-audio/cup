import crypto from "node:crypto";
import type http from "node:http";
import { Temporal } from "temporal-polyfill";

import { APPLE_SIGN_IN_KEY } from "#src/apple-sign-in-key.ts";

const APPLE_AUDIENCE = "https://appleid.apple.com";
const APPLE_NATIVE_CLIENT_ID = "audio.cup.app";
const APPLE_CLIENT_IDS = new Set(["audio.cup.app.web", APPLE_NATIVE_CLIENT_ID]);
const AUTHORIZATION_CODE_LIFETIME_MS = 5 * 60 * 1000;

export type AppleEndpoint = "/auth/token" | "/auth/revoke";

export type AppleRequest = {
  path: AppleEndpoint;
  clientId: string;
  grantType?: string;
  tokenTypeHint?: string;
  token: string;
  atMs: number;
};

type FakeAppleOptions = {
  signIdToken: (claims: Record<string, unknown>) => string;
};

export function createFakeApple({ signIdToken }: FakeAppleOptions) {
  const refreshTokens = new Map<string, { subject: string; isRevoked: boolean }>();
  const authorizationCodes = new Map<
    string,
    { subject: () => string; expiresAtMs: number; isUsed: boolean }
  >();
  const requests: AppleRequest[] = [];
  let failure: AppleEndpoint | undefined;
  let tokenSubject: string | undefined;

  const handle = async (
    path: AppleEndpoint,
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => {
    const form = new URLSearchParams(await readBody(request));
    const clientId = form.get("client_id") ?? "";
    if (!isClientSecretValid(form.get("client_secret") ?? "", clientId)) {
      response.writeHead(400).end(JSON.stringify({ error: "invalid_client" }));
      return;
    }
    const grantType = form.get("grant_type");
    const token =
      (path === "/auth/revoke"
        ? form.get("token")
        : grantType === "authorization_code"
          ? form.get("code")
          : form.get("refresh_token")) ?? "";
    requests.push({
      path,
      clientId,
      ...(path === "/auth/token"
        ? { grantType: grantType ?? "" }
        : { tokenTypeHint: form.get("token_type_hint") ?? "" }),
      token,
      atMs: Temporal.Now.instant().epochMilliseconds,
    });
    if (path === "/auth/revoke") {
      revoke(token, response);
      return;
    }
    if (failure === path) {
      response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    const tokens =
      grantType === "authorization_code"
        ? exchangeAuthorizationCode(clientId, token)
        : grantType === "refresh_token"
          ? validateRefreshToken(clientId, token)
          : undefined;
    if (tokens === undefined) {
      response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    response.end(JSON.stringify({ ...accessTokenFields(), ...tokens }));
  };
  const revoke = (token: string, response: http.ServerResponse) => {
    if (failure === "/auth/revoke") {
      response.writeHead(503).end(JSON.stringify({ error: "temporarily_unavailable" }));
      return;
    }
    const issued = refreshTokens.get(token);
    if (issued) {
      issued.isRevoked = true;
    }
    response.writeHead(200).end();
  };
  const exchangeAuthorizationCode = (clientId: string, token: string) => {
    const code = authorizationCodes.get(token);
    if (
      clientId !== APPLE_NATIVE_CLIENT_ID ||
      code === undefined ||
      code.isUsed ||
      Temporal.Now.instant().epochMilliseconds >= code.expiresAtMs
    ) {
      return undefined;
    }
    code.isUsed = true;
    const subject = code.subject();
    return { refresh_token: issueRefreshToken(subject), id_token: idTokenFor(clientId, subject) };
  };
  const validateRefreshToken = (clientId: string, token: string) => {
    const issued = refreshTokens.get(token);
    if (issued === undefined || issued.isRevoked) {
      return undefined;
    }
    return { id_token: idTokenFor(clientId, issued.subject) };
  };
  const idTokenFor = (clientId: string, subject: string) => {
    const now = Math.floor(Temporal.Now.instant().epochMilliseconds / 1000);
    return signIdToken({
      iss: APPLE_AUDIENCE,
      aud: clientId,
      sub: tokenSubject ?? subject,
      iat: now,
      exp: now + 600,
    });
  };
  const issueRefreshToken = (subject: string) => {
    const token = `qa-apple-${crypto.randomUUID()}`;
    refreshTokens.set(token, { subject, isRevoked: false });
    return token;
  };

  return {
    handle,
    issueRefreshToken,
    issueAuthorizationCode(subject: () => string) {
      const code = `qa-apple-code-${crypto.randomUUID()}`;
      authorizationCodes.set(code, {
        subject,
        expiresAtMs: Temporal.Now.instant().epochMilliseconds + AUTHORIZATION_CODE_LIFETIME_MS,
        isUsed: false,
      });
      return code;
    },
    expireAuthorizationCodes() {
      for (const code of authorizationCodes.values()) {
        code.expiresAtMs = 0;
      }
    },
    requests: () => requests.map((request) => ({ ...request })),
    setFailure(endpoint: AppleEndpoint | undefined) {
      failure = endpoint;
    },
    setTokenSubject(subject: string | undefined) {
      tokenSubject = subject;
    },
  };
}

function accessTokenFields() {
  return {
    access_token: `qa-apple-access-${crypto.randomUUID()}`,
    token_type: "Bearer",
    expires_in: 3600,
  };
}

function isClientSecretValid(clientSecret: string, clientId: string): boolean {
  const [header, payload, signature] = clientSecret.split(".");
  if (header === undefined || payload === undefined || signature === undefined) {
    return false;
  }
  if (
    !crypto.verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key: APPLE_SIGN_IN_KEY.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    )
  ) {
    return false;
  }
  const decodedHeader: unknown = JSON.parse(Buffer.from(header, "base64url").toString());
  const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString());
  const now = Math.floor(Temporal.Now.instant().epochMilliseconds / 1000);
  return (
    isRecord(decodedHeader) &&
    decodedHeader["alg"] === "ES256" &&
    decodedHeader["kid"] === APPLE_SIGN_IN_KEY.keyId &&
    isRecord(claims) &&
    claims["iss"] === APPLE_SIGN_IN_KEY.teamId &&
    claims["aud"] === APPLE_AUDIENCE &&
    claims["sub"] === clientId &&
    APPLE_CLIENT_IDS.has(clientId) &&
    typeof claims["exp"] === "number" &&
    claims["exp"] > now
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
}
