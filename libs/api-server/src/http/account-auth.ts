import { captureException } from "@sentry/core";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

import type { SignInMethod } from "@cup/listener-api.routes";

import { isOAuthProvider } from "#src/adapters/supabase-user.ts";
import type { ApiServerEnvironment } from "#src/api-server-environment.ts";
import { ingressIdentity } from "#src/http/ingress-identity.ts";
import { authenticateAccount as authenticateVerifiedAccount } from "#src/use-cases/authenticate-account.ts";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export type LocalTestAccount = { email: string; password: string };

export function localTestAccount(env: ApiServerEnvironment): LocalTestAccount | undefined {
  if (
    env.LOCAL_DEVELOPMENT !== "true" ||
    !env.LOCAL_TEST_ACCOUNT_EMAIL ||
    !env.LOCAL_TEST_ACCOUNT_PASSWORD
  ) {
    return undefined;
  }
  return { email: env.LOCAL_TEST_ACCOUNT_EMAIL, password: env.LOCAL_TEST_ACCOUNT_PASSWORD };
}

export async function verifyAccountToken(
  token: string,
  { supabaseUrl, testAccountEmail }: { supabaseUrl: string; testAccountEmail?: string | undefined },
  getKey?: JWTVerifyGetKey,
) {
  const issuer = `${supabaseUrl.replace(/\/$/, "")}/auth/v1`;
  let keys: JWTVerifyGetKey | undefined = getKey ?? keySets.get(issuer);
  if (!keys) {
    const remote = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    keySets.set(issuer, remote);
    keys = remote;
  }
  const { payload } = await jwtVerify(token, keys, {
    issuer,
    audience: "authenticated",
    algorithms: ["ES256", "RS256"],
  });
  if (
    !payload.sub ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(payload.sub) ||
    payload["role"] !== "authenticated" ||
    payload["is_anonymous"] === true ||
    typeof payload.exp !== "number" ||
    typeof payload.iat !== "number"
  ) {
    throw new errors.JWTClaimValidationFailed("Invalid account identity", payload);
  }
  const providers = admittedProviders(payload, testAccountEmail);
  if (providers.length === 0) {
    throw new errors.JWTClaimValidationFailed("Unsupported sign-in provider", payload);
  }
  const freshMethods = providers.includes("test-account") ? ["password"] : ["oauth", "id_token"];
  const amr = payload["amr"];
  const authenticatedAtSeconds = Array.isArray(amr)
    ? Math.max(
        0,
        ...amr.flatMap((entry: unknown) => {
          if (
            !entry ||
            typeof entry !== "object" ||
            !("method" in entry) ||
            !("timestamp" in entry)
          ) {
            return [];
          }
          return freshMethods.includes(String(entry.method)) && typeof entry.timestamp === "number"
            ? [entry.timestamp]
            : [];
        }),
      )
    : 0;
  return {
    providers,
    subject: payload.sub,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    authenticatedAtSeconds,
    email: typeof payload["email"] === "string" ? payload["email"] : undefined,
  };
}

function admittedProviders(
  payload: JWTPayload,
  testAccountEmail: string | undefined,
): SignInMethod[] {
  const metadata = payload["app_metadata"];
  if (!metadata || typeof metadata !== "object") {
    return [];
  }
  if (
    testAccountEmail !== undefined &&
    "provider" in metadata &&
    metadata.provider === "email" &&
    payload["email"] === testAccountEmail
  ) {
    return ["test-account"];
  }
  if (!("providers" in metadata) || !Array.isArray(metadata.providers)) {
    return [];
  }
  return metadata.providers.filter(isOAuthProvider);
}

export async function authenticateAccountRequest(request: Request, env: ApiServerEnvironment) {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return { result: "unauthorized" } as const;
  }
  let identity: Awaited<ReturnType<typeof verifyAccountToken>>;
  try {
    identity = await verifyAccountToken(authorization.slice(7), {
      supabaseUrl: env.SUPABASE_URL,
      testAccountEmail: localTestAccount(env)?.email,
    });
  } catch (error) {
    if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) {
      return { result: "unauthorized" } as const;
    }
    captureException(error);
    return { result: "unavailable" } as const;
  }
  try {
    const accounts = env.ACCOUNTS;
    const result = await authenticateVerifiedAccount(identity.subject, {
      registry: env.REGISTRY.get(env.REGISTRY.idFromName("registry")),
      getIngressIdentity: () => ingressIdentity(request, env.LOCAL_DEVELOPMENT === "true"),
      getAccount: (accountId) => accounts.get(accounts.idFromName(accountId)),
    });
    return result.result === "authenticated" ? { ...result, identity } : result;
  } catch (error) {
    captureException(error);
    return { result: "unavailable" } as const;
  }
}
