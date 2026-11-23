import { decodeJwt, importPKCS8, SignJWT } from "jose";
import { z } from "zod";

import { CupError } from "@cup/errors";

import type { ApiServerEnvironment } from "#src/api-server-environment.ts";

const APPLE_AUDIENCE = "https://appleid.apple.com";
const CLIENT_SECRET_LIFETIME_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 5_000;

export type AppleSignInRevocation = "revoked" | "mismatch";

export async function revokeVerifiedAppleRefreshToken(
  env: ApiServerEnvironment,
  subject: string,
  refreshToken: string,
): Promise<AppleSignInRevocation> {
  const linkedAppleSubject = await appleIdentitySubject(env, subject);
  const clientId = env.APPLE_WEB_CLIENT_ID;
  const clientSecret = await signClientSecret(env, clientId);
  const validated = await postToApple(env, "/auth/token", "validation", {
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const { id_token: idToken } = z.object({ id_token: z.string() }).parse(await validated.json());
  if (decodeJwt(idToken).sub !== linkedAppleSubject) {
    return "mismatch";
  }
  const revoked = await postToApple(env, "/auth/revoke", "revocation", {
    client_id: clientId,
    client_secret: clientSecret,
    token: refreshToken,
    token_type_hint: "refresh_token",
  });
  await revoked.body?.cancel();
  return "revoked";
}

async function appleIdentitySubject(env: ApiServerEnvironment, subject: string) {
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${subject}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new CupError(`Supabase answered the Apple identity lookup with ${response.status}`);
  }
  const user = z
    .object({
      id: z.uuid(),
      identities: z.array(
        z.object({ provider: z.string(), identity_data: z.object({ sub: z.string() }) }),
      ),
    })
    .parse(await response.json());
  const apple = user.identities.find((identity) => identity.provider === "apple");
  if (user.id !== subject || !apple) {
    throw new CupError("The account has no Apple identity in Supabase");
  }
  return apple.identity_data.sub;
}

async function signClientSecret(env: ApiServerEnvironment, clientId: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: env.APPLE_KEY_ID })
    .setIssuer(env.APPLE_TEAM_ID)
    .setAudience(APPLE_AUDIENCE)
    .setSubject(clientId)
    .setIssuedAt()
    .setExpirationTime(`${CLIENT_SECRET_LIFETIME_SECONDS}s`)
    .sign(await importPKCS8(env.APPLE_SIGN_IN_KEY, "ES256"));
}

async function postToApple(
  env: ApiServerEnvironment,
  path: "/auth/token" | "/auth/revoke",
  step: "validation" | "revocation",
  form: Record<string, string>,
) {
  const response = await fetch(new URL(path, env.APPLE_ORIGIN), {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new CupError(`Apple answered the refresh token ${step} with ${response.status}`);
  }
  return response;
}
