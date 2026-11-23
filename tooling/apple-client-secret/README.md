# Apple client secret

This CLI signs the client secret Supabase's Apple provider sends to Apple, and checks that the Supabase access token the rotation workflow uses is not about to expire. The monthly [rotation workflow](../../docs/production-configuration.md#apple-client-secret-rotation) runs it with the runner's own `node` before any `pnpm install`, so `src/` imports nothing but Node built-ins and runs on Node 22.18 or newer through type stripping ([ADR 0118](../../docs/adr/0118-rotate-supabases-apple-client-secret-from-a-scheduled-github-actions-workflow.md)).

## Usage

```sh
APPLE_SIGN_IN_PRIVATE_KEY="$(cat AuthKey_6Y358M9M9A.p8)" node tooling/apple-client-secret/src/cli.ts sign
SUPABASE_ACCESS_TOKEN_EXPIRES_ON=2027-11-01 node tooling/apple-client-secret/src/cli.ts check-token-expiry
```

`sign` reads the Sign in with Apple `.p8` key as PEM from `APPLE_SIGN_IN_PRIVATE_KEY` and prints only the JWT, without a trailing newline: ES256 with `kid` `6Y358M9M9A`, `iss` team `4GQ2V3WJW8`, `aud` `https://appleid.apple.com`, `sub` the Services ID `audio.cup.app.web`, and an `exp` 179 days after `iat`, under Apple's six-month limit. It fails on a key that is not P-256.

`check-token-expiry` reads `SUPABASE_ACCESS_TOKEN_EXPIRES_ON` as `YYYY-MM-DD` and fails with a renewal message from 30 days (UTC) before that date, and on a missing or invalid date.

## Validation

Run `pnpm --filter @cup/apple-client-secret test` and `lint`. The tests sign a secret with a throwaway key and verify its header, claims, lifetime and signature against the public key, cover the expiry window and date parsing, and run the CLI as the workflow does.
