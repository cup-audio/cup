import { z } from "zod";

import { readSupabaseUser } from "#src/adapters/supabase-user.ts";
import type { ApiServerEnvironment } from "#src/api-server-environment.ts";

const REQUEST_TIMEOUT_MS = 5_000;

export async function revokeVerifiedGoogleToken(
  env: ApiServerEnvironment,
  subject: string,
  token: string,
) {
  const user = await readSupabaseUser(env, subject);
  const google = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!google.ok) {
    await google.body?.cancel();
    return false;
  }
  const identity = z.object({ sub: z.string() }).parse(await google.json());
  if (
    !user.identities.some((item) => item.provider === "google" && item.subject === identity.sub)
  ) {
    return false;
  }
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  await response.body?.cancel();
  return response.ok;
}
