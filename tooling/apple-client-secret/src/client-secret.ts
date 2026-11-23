import crypto from "node:crypto";

const APPLE_CLIENT_SECRET = {
  TEAM_ID: "4GQ2V3WJW8",
  KEY_ID: "6Y358M9M9A",
  SERVICES_ID: "audio.cup.app.web",
  AUDIENCE: "https://appleid.apple.com",
  LIFETIME_SECONDS: 179 * 24 * 60 * 60,
} as const;

export function signAppleClientSecret(privateKeyPem: string, issuedAtSeconds: number): string {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error(
      "The Sign in with Apple key must be a P-256 (prime256v1) EC private key, as Apple's .p8 keys are.",
    );
  }

  const header = encodeSegment({ alg: "ES256", kid: APPLE_CLIENT_SECRET.KEY_ID });
  const claims = encodeSegment({
    iss: APPLE_CLIENT_SECRET.TEAM_ID,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + APPLE_CLIENT_SECRET.LIFETIME_SECONDS,
    aud: APPLE_CLIENT_SECRET.AUDIENCE,
    sub: APPLE_CLIENT_SECRET.SERVICES_ID,
  });

  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });

  return `${signingInput}.${signature.toString("base64url")}`;
}

function encodeSegment(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
