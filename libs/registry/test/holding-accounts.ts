import type { DeletionAccounts } from "#src/account-deletion/deletion-coordinator.ts";

export type AccountMethod = "fenceDeletion" | "eraseAccount";

export type Hold = {
  reached: Promise<void>;
  release(): void;
};

type PendingHold = { method: AccountMethod; arrive(): Promise<void> };

export type HoldingAccounts = {
  accounts: DeletionAccounts;
  holdNext(method: AccountMethod): Hold;
};

export function createHoldingAccounts(realAccounts: DeletionAccounts): HoldingAccounts {
  const pendingHolds: PendingHold[] = [];

  async function pass(method: AccountMethod): Promise<void> {
    const holdIndex = pendingHolds.findIndex((hold) => hold.method === method);
    if (holdIndex === -1) {
      return;
    }
    const [hold] = pendingHolds.splice(holdIndex, 1);
    await hold?.arrive();
  }

  return {
    accounts: {
      idFromName: (name) => realAccounts.idFromName(name),
      get: (id) => {
        const account = realAccounts.get(id);
        return {
          fenceDeletion: async (attemptId) => {
            await pass("fenceDeletion");
            return account.fenceDeletion(attemptId);
          },
          eraseAccount: async (attemptId) => {
            await pass("eraseAccount");
            return account.eraseAccount(attemptId);
          },
        };
      },
    },
    holdNext(method) {
      const { promise: reached, resolve: resolveReached } = Promise.withResolvers<void>();
      const { promise: released, resolve: release } = Promise.withResolvers<void>();
      pendingHolds.push({
        method,
        arrive: () => {
          resolveReached();
          return released;
        },
      });
      return { reached, release };
    },
  };
}
