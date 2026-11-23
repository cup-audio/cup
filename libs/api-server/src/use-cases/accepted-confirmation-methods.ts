import type { AccountSnapshot } from "@cup/accounts";
import type { SignInMethod } from "@cup/listener-api.routes";

export function acceptedConfirmationMethods(
  providers: readonly SignInMethod[],
  accountState: AccountSnapshot["state"],
): SignInMethod[] {
  if (accountState === "active") {
    return providers.includes("google") ? ["google"] : [...providers];
  }
  return [...providers];
}
