import type { Session } from "@supabase/supabase-js";

import { sessionSnapshot, subscribeAuthState } from "#src/auth/account-session.js";
import { accountQuery } from "#src/data-fetching/account.js";
import { requestApi, RpcError } from "#src/data-fetching/api-request.js";
import { queryClient } from "#src/data-fetching/query-client.js";
import { takeCompletedAppleSignIn } from "#src/platform/account-auth.js";
import { reportFailure } from "#src/report-failure.js";

const revocations = new Map<string, Promise<void>>();

export function watchAppleSignInsDuringDeletion() {
  subscribeAuthState(checkCompletedAppleSignIn);
  checkCompletedAppleSignIn();
}

function checkCompletedAppleSignIn() {
  const session = sessionSnapshot();
  if (session !== null && takeCompletedAppleSignIn()) {
    void revokeIfScheduledForDeletion(session);
  }
}

export function claimAppleSignIn(refreshToken: string) {
  if (!revocations.has(refreshToken)) {
    revocations.set(refreshToken, Promise.resolve());
  }
}

export function revokeAppleSignIn(subject: string, refreshToken: string): Promise<void> {
  const known = revocations.get(refreshToken);
  if (known !== undefined) {
    return known;
  }
  const revocation = requestApi({ subject }, (client) =>
    client.revokeAppleSignIn({ providerCredential: { provider: "apple", refreshToken } }),
  ).then(() => undefined, reportFailure("Revoking an Apple sign-in during deletion failed"));
  revocations.set(refreshToken, revocation);
  return revocation;
}

async function revokeIfScheduledForDeletion(session: Session) {
  const refreshToken = session.provider_refresh_token;
  if (!refreshToken) {
    return;
  }
  const subject = session.user.id;
  const account = await queryClient.fetchQuery(accountQuery(subject)).catch((error: unknown) => {
    if (!(error instanceof RpcError)) {
      reportFailure("Reading the account after an Apple sign-in failed")(error);
    }
    return undefined;
  });
  if (account?.state === "deletion_scheduled" || account?.state === "deleting") {
    await revokeAppleSignIn(subject, refreshToken);
  }
}
