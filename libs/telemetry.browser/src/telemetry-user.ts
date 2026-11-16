import { SIGNED_OUT_USER } from "@cup/telemetry.core";

/** The only user telemetry knows: an opaque account ID, or `signed-out`. */
export type TelemetryUser = { id: string };

/** The account session as the user rule follows it. */
export type FollowedAccountSession = {
  /** The signed-in listener's auth subject, or `null` when signed out. */
  currentSubject(): string | null;
  /** Calls `listener` when the sign-in state may have changed; returns a function that stops it. */
  subscribe(listener: () => void): () => void;
  /** The opaque account ID of the account signed in as `subject`, from the Listener API. */
  loadAccountId(subject: string): Promise<string>;
};

/**
 * The user rule: telemetry's user is the opaque account ID once a signed-in listener's account is
 * known, and {@link SIGNED_OUT_USER} otherwise, sign-out and account deletion included. The auth
 * subject never becomes the user, and the user is never unset, because `setUser(null)` would let a
 * native SDK fill in its installation ID. A failed account load leaves the user signed out; the
 * failed request is a breadcrumb.
 *
 * Returns a function that stops following.
 */
export function followAccountSession(
  session: FollowedAccountSession,
  setUser: (user: TelemetryUser) => void,
): () => void {
  let followedSubject: string | null = null;
  let appliedUserId: string | undefined;

  const apply = (user: TelemetryUser) => {
    if (user.id !== appliedUserId) {
      appliedUserId = user.id;
      setUser(user);
    }
  };

  const follow = () => {
    const subject = session.currentSubject();
    if (subject === followedSubject) {
      return;
    }
    followedSubject = subject;
    apply(SIGNED_OUT_USER);
    if (subject === null) {
      return;
    }

    void loadUser(subject);
  };

  const loadUser = async (subject: string) => {
    const accountId = await session.loadAccountId(subject).catch(() => undefined);
    // The listener may have signed out, or in as someone else, while the account loaded.
    if (accountId !== undefined && followedSubject === subject) {
      apply({ id: accountId });
    }
  };

  const unsubscribe = session.subscribe(follow);
  apply(SIGNED_OUT_USER);
  follow();
  return unsubscribe;
}
