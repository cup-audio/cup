import process from "node:process";

import { assertAccessTokenNotExpiringSoon } from "#src/access-token-expiry.ts";
import { signAppleClientSecret } from "#src/client-secret.ts";

const MILLISECONDS_PER_SECOND = 1000;
const USAGE = "Usage: node tooling/apple-client-secret/src/cli.ts <sign|check-token-expiry>";

try {
  const nowMilliseconds = performance.timeOrigin + performance.now();
  const command = process.argv[2];
  if (command === "sign") {
    const privateKeyPem = process.env["APPLE_SIGN_IN_PRIVATE_KEY"];
    if (!privateKeyPem?.trim()) {
      throw new Error("APPLE_SIGN_IN_PRIVATE_KEY must hold the Sign in with Apple .p8 key as PEM.");
    }
    process.stdout.write(
      signAppleClientSecret(privateKeyPem, Math.floor(nowMilliseconds / MILLISECONDS_PER_SECOND)),
    );
  } else if (command === "check-token-expiry") {
    assertAccessTokenNotExpiringSoon(
      process.env["SUPABASE_ACCESS_TOKEN_EXPIRES_ON"],
      nowMilliseconds,
    );
  } else {
    throw new Error(USAGE);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
