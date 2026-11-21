import { captureEvent, captureException } from "@sentry/core";

import type { AccountSnapshot } from "@cup/accounts";
import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

export type AuthenticateAccountDependencies<Account> = {
  registry: {
    findIdentity(subject: string): Promise<{ accountId: string; phase: string } | undefined>;
    provisionFromIngress(
      subject: string,
      key: string,
    ): Promise<
      | { result: "rate-limited"; retryAfter: number }
      | { result: "provisioned"; snapshot: AccountSnapshot }
    >;
    provisionVerifiedIdentity(subject: string): Promise<AccountSnapshot>;
  };
  getIngressIdentity(): Promise<string | undefined>;
  getAccount(accountId: string): Account;
};

/** A verified sign-in identity, and whether its email is on the account allowlist. */
export type VerifiedIdentity = { subject: string; isOnAccountAllowlist: boolean };

/**
 * Resolve a verified identity, provisioning or resuming its account when necessary. An identity off
 * the account allowlist is refused before either, whether or not it already has an account.
 */
export async function authenticateAccount<Account extends { inspect(): Promise<AccountSnapshot> }>(
  { subject, isOnAccountAllowlist }: VerifiedIdentity,
  dependencies: AuthenticateAccountDependencies<Account>,
) {
  try {
    const { registry } = dependencies;
    const mapping = await registry.findIdentity(subject);
    if (!isOnAccountAllowlist) {
      reportIdentityNotAdmitted(subject, mapping?.accountId);
      return { result: "not-admitted" } as const;
    }

    if (!mapping || mapping.phase === "provisioning") {
      let snapshot;
      if (!mapping) {
        const key = await dependencies.getIngressIdentity();
        if (!key) {
          return { result: "unavailable" } as const;
        }
        const provision = await registry.provisionFromIngress(subject, key);
        if (provision.result === "rate-limited") {
          return { result: "rate-limited", retryAfter: provision.retryAfter } as const;
        }
        snapshot = provision.snapshot;
      } else {
        snapshot = await registry.provisionVerifiedIdentity(subject);
      }
      return {
        result: "authenticated",
        snapshot,
        account: dependencies.getAccount(snapshot.accountId),
      } as const;
    }
    if (mapping.phase !== "active") {
      return { result: "blocked" } as const;
    }
    const account = dependencies.getAccount(mapping.accountId);
    const snapshot = await account.inspect();
    return { result: "authenticated", snapshot, account } as const;
  } catch (error) {
    // Every caller answers this result with a 503.
    captureException(error);
    return { result: "unavailable" } as const;
  }
}

/**
 * One Sentry warning per refusal, all in one issue through the fixed fingerprint, so the operator
 * sees how often identities off the account allowlist try. It names the Supabase subject, never the
 * email address (docs/architecture/observability.md).
 */
function reportIdentityNotAdmitted(subject: string, accountId: string | undefined) {
  captureEvent({
    level: "warning",
    message: `Identity ${subject} is not on the account allowlist`,
    fingerprint: ["account-not-admitted"],
    tags: {
      [TELEMETRY_ATTRIBUTES.IDENTITY_SUBJECT]: subject,
      [TELEMETRY_ATTRIBUTES.IDENTITY_HAS_ACCOUNT]: String(accountId !== undefined),
      ...(accountId === undefined ? {} : { [TELEMETRY_ATTRIBUTES.ACCOUNT_ID]: accountId }),
    },
  });
}
