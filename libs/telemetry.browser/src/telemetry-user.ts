import { SIGNED_OUT_USER } from "@cup/telemetry.core";

export type TelemetryUser = { id: string };

export type FollowedAccountSession = {
  currentSubject(): string | null;
  subscribe(listener: () => void): () => void;
  loadAccountId(subject: string): Promise<string>;
};

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
    if (accountId !== undefined && followedSubject === subject) {
      apply({ id: accountId });
    }
  };

  const unsubscribe = session.subscribe(follow);
  apply(SIGNED_OUT_USER);
  follow();
  return unsubscribe;
}
