import { expect, test } from "vitest";

import { followAccountSession, type TelemetryUser } from "#src/telemetry-user.ts";

const SUBJECT = "0b8e8f4c-6f1d-4a43-9a52-2f5d4bb0f6a1";
const ACCOUNT_ID = "5d2c7a4e-1b9f-4c8e-8a3d-6e0f2b1c9d7a";

function createFakeAccountSession() {
  let subject: string | null = null;
  const listeners = new Set<() => void>();
  const loads: Array<{ subject: string } & PromiseWithResolvers<string>> = [];

  return {
    loads,
    signIn(nextSubject: string) {
      subject = nextSubject;
      for (const listener of listeners) {
        listener();
      }
    },
    signOut() {
      subject = null;
      for (const listener of listeners) {
        listener();
      }
    },
    session: {
      currentSubject: () => subject,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      loadAccountId(loadedSubject: string) {
        const load = { subject: loadedSubject, ...Promise.withResolvers<string>() };
        loads.push(load);
        return load.promise;
      },
    },
  };
}

test("a signed-out listener is the signed-out user", () => {
  const fake = createFakeAccountSession();
  const users: TelemetryUser[] = [];

  followAccountSession(fake.session, (user) => users.push(user));

  expect(users).toEqual([{ id: "signed-out" }]);
});

test("a signed-in listener becomes their opaque account ID once it loads, and signed-out again after sign-out", async () => {
  const fake = createFakeAccountSession();
  const users: TelemetryUser[] = [];
  followAccountSession(fake.session, (user) => users.push(user));

  fake.signIn(SUBJECT);
  expect(fake.loads.map(({ subject }) => subject)).toEqual([SUBJECT]);
  fake.loads[0]?.resolve(ACCOUNT_ID);
  await expect.poll(() => users.at(-1)).toEqual({ id: ACCOUNT_ID });

  fake.signOut();

  expect(users).toEqual([{ id: "signed-out" }, { id: ACCOUNT_ID }, { id: "signed-out" }]);
});

test("an account ID that loads after sign-out is not applied", async () => {
  const fake = createFakeAccountSession();
  const users: TelemetryUser[] = [];
  followAccountSession(fake.session, (user) => users.push(user));

  fake.signIn(SUBJECT);
  fake.signOut();
  fake.loads[0]?.resolve(ACCOUNT_ID);
  await fake.loads[0]?.promise;
  await Promise.resolve();

  expect(users).toEqual([{ id: "signed-out" }]);
});

test("a failed account load keeps the signed-out user, never the subject", async () => {
  const fake = createFakeAccountSession();
  const users: TelemetryUser[] = [];
  followAccountSession(fake.session, (user) => users.push(user));

  fake.signIn(SUBJECT);
  fake.loads[0]?.reject(new Error("Account setup unavailable."));
  await fake.loads[0]?.promise.catch(() => undefined);
  await Promise.resolve();

  expect(users).toEqual([{ id: "signed-out" }]);
});

test("an unchanged sign-in loads the account once", () => {
  const fake = createFakeAccountSession();
  followAccountSession(fake.session, () => undefined);

  fake.signIn(SUBJECT);
  fake.signIn(SUBJECT);

  expect(fake.loads).toHaveLength(1);
});
