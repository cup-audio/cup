/*
 * What must hold before `android:release` starts Gradle: a clean, pushed commit and the upload key in
 * place. Git and the upload key's storage sit behind small interfaces so tests can fake them.
 */

export type ReleaseGit = {
  /**
   * Whether tracked files differ from `HEAD`, staged or not. Ignored and untracked files don't
   * count.
   */
  hasTrackedChanges(): boolean;
  /** The remote-tracking branches, such as `origin/main`, that contain `HEAD`. */
  remoteBranchesContainingHead(): readonly string[];
};

export type UploadKeyStore = {
  keystorePath: string;
  /**
   * Names the Keychain item in a message, such as `the Keychain generic-password item with service
   * "…"`.
   */
  keychainItemDescription: string;
  hasKeystore(): boolean;
  hasKeychainItem(): boolean;
};

/** Returns a message for every failed precondition; empty when the release may start. */
export function findFailedReleasePreconditions({
  git,
  uploadKey,
}: {
  git: ReleaseGit;
  uploadKey: UploadKeyStore;
}): string[] {
  const failures: string[] = [];

  if (git.hasTrackedChanges()) {
    failures.push(
      "Tracked files have changes. Commit or discard them, so that the release names exactly the commit testers run.",
    );
  }
  if (git.remoteBranchesContainingHead().length === 0) {
    failures.push(
      "HEAD is on no remote-tracking branch. Push it first, so that the commit named in the release stays reachable.",
    );
  }
  if (!uploadKey.hasKeystore()) {
    failures.push(`The upload keystore ${uploadKey.keystorePath} is missing.`);
  }
  if (!uploadKey.hasKeychainItem()) {
    failures.push(`The upload key's password, ${uploadKey.keychainItemDescription}, is missing.`);
  }

  return failures;
}
