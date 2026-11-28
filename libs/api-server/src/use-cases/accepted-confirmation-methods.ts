import type { AccountSnapshot } from "@cup/accounts";
import type { SignInMethod } from "@cup/listener-api.routes";

import { confirmationProvider } from "#src/use-cases/confirmation-provider.ts";

export function acceptedConfirmationMethods(
  providers: readonly SignInMethod[],
  accountState: AccountSnapshot["state"],
): SignInMethod[] {
  if (accountState !== "active") {
    return [...providers];
  }
  const provider = confirmationProvider(providers);
  return provider === undefined ? [...providers] : [provider];
}
