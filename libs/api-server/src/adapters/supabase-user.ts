import { z } from "zod";

import { CupError } from "@cup/errors";

import type { ApiServerEnvironment } from "#src/api-server-environment.ts";

const REQUEST_TIMEOUT_MS = 5_000;

type SupabaseUser = { email: string | undefined; providers: string[] };

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
      identities: z.array(z.object({ provider: z.string() })),
    })
    .parse(await response.json());
  if (user.id !== subject) {
    throw new CupError("Supabase answered the user lookup with another user");
  }
  return {
    email: user.email === undefined || user.email === "" ? undefined : user.email.toLowerCase(),
    providers: user.identities.map(({ provider }) => provider),
  };
}
