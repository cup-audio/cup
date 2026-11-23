import { Temporal } from "temporal-polyfill";
import { z } from "zod";

import { deletionChallengeSchema, signInMethodSchema } from "@cup/listener-api.routes";

export const ACCOUNT_CONFIRMATION_STORAGE_KEY = "cup_account_confirmation";
const challengeSchema = deletionChallengeSchema.extend({
  action: z.enum(["delete", "restore"]),
  signInMethod: signInMethodSchema.optional(),
});
export type AccountChallenge = z.infer<typeof challengeSchema>;

export function storeAccountChallenge(challenge: AccountChallenge) {
  window.sessionStorage.setItem(ACCOUNT_CONFIRMATION_STORAGE_KEY, JSON.stringify(challenge));
}

export function clearAccountChallenge() {
  window.sessionStorage.removeItem(ACCOUNT_CONFIRMATION_STORAGE_KEY);
}

export function readPendingAccountChallenge() {
  try {
    const parsed = challengeSchema.safeParse(
      JSON.parse(window.sessionStorage.getItem(ACCOUNT_CONFIRMATION_STORAGE_KEY) ?? "null"),
    );
    if (parsed.success && parsed.data.expiresAtMs > Temporal.Now.instant().epochMilliseconds) {
      return parsed.data;
    }
  } catch {}
  clearAccountChallenge();
  return null;
}
