import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { test } from "vitest";

const CLI_PATH = path.join(import.meta.dirname, "../src/cli.ts");
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function utcDateInDays(days: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(
    performance.timeOrigin + performance.now() + days * MILLISECONDS_PER_DAY,
  );
}

function runCli(args: string[], env: Record<string, string>) {
  return childProcess.spawnSync(process.execPath, [CLI_PATH, ...args], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
    encoding: "utf8",
  });
}

test("sign prints only a client secret signed with the key from APPLE_SIGN_IN_PRIVATE_KEY", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });

  const result = runCli(["sign"], { APPLE_SIGN_IN_PRIVATE_KEY: privateKeyPem });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.endsWith("\n"), false);
  const [header = "", claims = "", signature = ""] = result.stdout.split(".");
  assert.ok(
    crypto.verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
  );
});

test("sign fails without printing anything when APPLE_SIGN_IN_PRIVATE_KEY is missing", () => {
  const result = runCli(["sign"], {});

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /APPLE_SIGN_IN_PRIVATE_KEY/);
});

test("check-token-expiry fails with the renewal message when SUPABASE_ACCESS_TOKEN_EXPIRES_ON is close", () => {
  const inTenDays = utcDateInDays(10);

  const result = runCli(["check-token-expiry"], { SUPABASE_ACCESS_TOKEN_EXPIRES_ON: inTenDays });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Renew it/);
});

test("check-token-expiry passes when the token expires in a year", () => {
  const inAYear = utcDateInDays(365);

  const result = runCli(["check-token-expiry"], { SUPABASE_ACCESS_TOKEN_EXPIRES_ON: inAYear });

  assert.equal(result.status, 0, result.stderr);
});

test("rejects an unknown command with the usage", () => {
  const result = runCli(["rotate"], {});

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Usage: node tooling\/apple-client-secret\/src\/cli\.ts <sign\|check-token-expiry>/,
  );
});
