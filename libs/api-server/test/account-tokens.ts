import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Temporal } from "temporal-polyfill";

const KEY_ID = "account-token-key";

export type AccountTokenClaims = {
  provider?: string;
  providers?: string[];
  authenticationMethod?: string;
  email?: string;
  authenticatedAtSeconds?: number;
};

export type AccountTokenIssuer = {
  supabaseUrl: string;
  respondToKeySetRequest: (input: RequestInfo | URL) => Promise<Response> | undefined;
  fetchKeySetOnly: (input: RequestInfo | URL) => Promise<Response>;
  sign: (subject: string, claims?: AccountTokenClaims) => Promise<string>;
};

export async function createAccountTokenIssuer(supabaseUrl: string): Promise<AccountTokenIssuer> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const issuer = `${supabaseUrl}/auth/v1`;
  const publicJwk = { ...(await exportJWK(publicKey)), kid: KEY_ID };

  const respondToKeySetRequest = (input: RequestInfo | URL) =>
    requestUrl(input) === `${issuer}/.well-known/jwks.json`
      ? Promise.resolve(Response.json({ keys: [publicJwk] }))
      : undefined;

  return {
    supabaseUrl,
    respondToKeySetRequest,
    fetchKeySetOnly: async (input) => {
      const keySet = respondToKeySetRequest(input);
      if (keySet === undefined) {
        throw new Error(`Unexpected request to ${requestUrl(input)}`);
      }
      return keySet;
    },
    sign: async (
      subject,
      {
        providers = ["google"],
        provider = providers[0],
        authenticationMethod = "oauth",
        email = "listener@example.com",
        authenticatedAtSeconds = Math.floor(Temporal.Now.instant().epochMilliseconds / 1_000),
      } = {},
    ) =>
      new SignJWT({
        role: "authenticated",
        is_anonymous: false,
        email,
        app_metadata: { provider, providers },
        ...(authenticatedAtSeconds === 0
          ? {}
          : { amr: [{ method: authenticationMethod, timestamp: authenticatedAtSeconds }] }),
      })
        .setProtectedHeader({ alg: "ES256", kid: KEY_ID })
        .setSubject(subject)
        .setIssuer(issuer)
        .setAudience("authenticated")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey),
  };
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : input.toString();
}
