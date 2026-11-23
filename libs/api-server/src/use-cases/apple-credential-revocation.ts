import { captureException } from "@sentry/core";

import type { AccountSnapshot } from "@cup/accounts";
import type { AppleProviderCredential, ProviderCredential } from "@cup/listener-api.routes";

import type { AppleSignInRevocation } from "#src/adapters/apple-sign-in-revocation.ts";
import { isAppleLinked } from "#src/use-cases/confirmation-provider.ts";

export type AppleCredentialRevocation = AppleSignInRevocation | "failed";

export type AppleDeletionConfirmation =
  | { result: "not-apple-linked" }
  | { result: "credential-required" }
  | { result: AppleCredentialRevocation };

export type RevokeAppleCredential = (
  credential: AppleProviderCredential,
) => Promise<AppleSignInRevocation>;

export async function confirmDeletionWithApple(
  providers: readonly string[],
  credential: ProviderCredential | undefined,
  revoke: RevokeAppleCredential,
): Promise<AppleDeletionConfirmation> {
  if (!isAppleLinked(providers)) {
    return { result: "not-apple-linked" };
  }
  if (credential?.provider !== "apple") {
    return { result: "credential-required" };
  }
  return { result: await revokeAppleCredential(credential, revoke) };
}

export async function revokeAppleSignInDuringDeletion(
  providers: readonly string[],
  accountState: AccountSnapshot["state"],
  credential: AppleProviderCredential,
  revoke: RevokeAppleCredential,
): Promise<void> {
  if (
    (accountState === "deletion_scheduled" || accountState === "deleting") &&
    isAppleLinked(providers)
  ) {
    await revokeAppleCredential(credential, revoke);
  }
}

async function revokeAppleCredential(
  credential: AppleProviderCredential,
  revoke: RevokeAppleCredential,
): Promise<AppleCredentialRevocation> {
  try {
    return await revoke(credential);
  } catch (error) {
    captureException(error);
    return "failed";
  }
}
