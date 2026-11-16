import type { ConversionOwner } from "@cup/conversion-contracts";
import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

/**
 * The keys that name a conversion's owner: `cup.owner.kind` and the opaque owner ID. A trial
 * conversion's owner is its conversion grant, so its kind is `grant`.
 */
export function conversionOwnerKeys(owner: ConversionOwner): Record<string, string> {
  return owner.kind === "account"
    ? {
        [TELEMETRY_ATTRIBUTES.OWNER_KIND]: "account",
        [TELEMETRY_ATTRIBUTES.ACCOUNT_ID]: owner.accountId,
      }
    : {
        [TELEMETRY_ATTRIBUTES.OWNER_KIND]: "grant",
        [TELEMETRY_ATTRIBUTES.CONVERSION_GRANT_ID]: owner.grantId,
      };
}
