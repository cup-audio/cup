import { z } from "zod";

import { CupError } from "@cup/errors";
import type { SignInMethod } from "@cup/listener-api.routes";

import { REQUEST_TIMEOUT_MS } from "#src/adapters/request-timeout.ts";
import type { ApiServerEnvironment } from "#src/api-server-environment.ts";

export type OAuthProvider = Extract<SignInMethod, "google" | "apple">;

export type SupabaseIdentity = { provider: string; subject: string | undefined };

export type SupabaseUser = {
  email: string | undefined;
  identities: SupabaseIdentity[];
  providers: OAuthProvider[];
};

const OAUTH_PROVIDERS: readonly OAuthProvider[] = ["google", "apple"];

export async function readSupabaseUser(
  env: ApiServerEnvironment,
  subject: string,
): Promise<SupabaseUser> {
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${subject}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new CupError(`Supabase answered the user lookup with ${response.status}`);
  }
  const user = z
    .object({
      id: z.uuid(),
      email: z.string().optional(),
      identities: z.array(
        z.object({
          provider: z.string(),
          identity_data: z.object({ sub: z.string().optional() }).optional(),
        }),
      ),
    })
    .parse(await response.json());
  if (user.id !== subject) {
    throw new CupError("Supabase answered the user lookup with another user");
  }
  const identities = user.identities.map((identity) => ({
    provider: identity.provider,
    subject: identity.identity_data?.sub,
  }));
  return {
    email: user.email === undefined || user.email === "" ? undefined : user.email.toLowerCase(),
    identities,
    providers: identities.map(({ provider }) => provider).filter(isOAuthProvider),
  };
}

export function isOAuthProvider(provider: unknown): provider is OAuthProvider {
  return OAUTH_PROVIDERS.some((admitted) => admitted === provider);
}
