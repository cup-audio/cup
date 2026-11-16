import { expect, test } from "vitest";

import { findFailedReleasePreconditions } from "#scripts/release/release-preconditions.mts";
import type { ReleaseGit, UploadKeyStore } from "#scripts/release/release-preconditions.mts";

const KEYSTORE_PATH = "/checkout/apps/mobile-app/android/upload-keystore.jks";

function fakeGit({
  hasTrackedChanges = false,
  remoteBranchesContainingHead = ["origin/main"],
}: {
  hasTrackedChanges?: boolean;
  remoteBranchesContainingHead?: readonly string[];
} = {}): ReleaseGit {
  return {
    hasTrackedChanges: () => hasTrackedChanges,
    remoteBranchesContainingHead: () => remoteBranchesContainingHead,
  };
}

function fakeUploadKey({
  hasKeystore = true,
  hasKeychainItem = true,
}: {
  hasKeystore?: boolean;
  hasKeychainItem?: boolean;
} = {}): UploadKeyStore {
  return {
    keystorePath: KEYSTORE_PATH,
    keychainItemDescription: 'the Keychain item "cup-android-upload-key"',
    hasKeystore: () => hasKeystore,
    hasKeychainItem: () => hasKeychainItem,
  };
}

test("a clean, pushed commit with the upload key in place passes", () => {
  expect(findFailedReleasePreconditions({ git: fakeGit(), uploadKey: fakeUploadKey() })).toEqual(
    [],
  );
});

test("a commit on a feature branch's remote-tracking branch passes", () => {
  const git = fakeGit({ remoteBranchesContainingHead: ["origin/claude/some-feature"] });

  expect(findFailedReleasePreconditions({ git, uploadKey: fakeUploadKey() })).toEqual([]);
});

test("tracked changes fail", () => {
  const failures = findFailedReleasePreconditions({
    git: fakeGit({ hasTrackedChanges: true }),
    uploadKey: fakeUploadKey(),
  });

  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatch(/tracked files have changes/i);
});

test("a HEAD on no remote-tracking branch fails", () => {
  const failures = findFailedReleasePreconditions({
    git: fakeGit({ remoteBranchesContainingHead: [] }),
    uploadKey: fakeUploadKey(),
  });

  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatch(/no remote-tracking branch/);
});

test("a missing keystore fails, naming its path", () => {
  const failures = findFailedReleasePreconditions({
    git: fakeGit(),
    uploadKey: fakeUploadKey({ hasKeystore: false }),
  });

  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain(KEYSTORE_PATH);
});

test("a missing Keychain item fails, naming the item", () => {
  const failures = findFailedReleasePreconditions({
    git: fakeGit(),
    uploadKey: fakeUploadKey({ hasKeychainItem: false }),
  });

  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain('the Keychain item "cup-android-upload-key"');
});

test("a failed Keychain lookup is reported with the other failed preconditions", () => {
  const uploadKey: UploadKeyStore = {
    ...fakeUploadKey({ hasKeystore: false }),
    hasKeychainItem: () => {
      throw new Error("security exited with 51: User interaction is not allowed.");
    },
  };

  const failures = findFailedReleasePreconditions({ git: fakeGit(), uploadKey });

  expect(failures).toHaveLength(2);
  expect(failures[0]).toContain(KEYSTORE_PATH);
  expect(failures[1]).toContain('the Keychain item "cup-android-upload-key"');
  expect(failures[1]).toContain("User interaction is not allowed.");
});

test("every failed precondition is reported at once", () => {
  const failures = findFailedReleasePreconditions({
    git: fakeGit({ hasTrackedChanges: true, remoteBranchesContainingHead: [] }),
    uploadKey: fakeUploadKey({ hasKeystore: false, hasKeychainItem: false }),
  });

  expect(failures).toHaveLength(4);
});
