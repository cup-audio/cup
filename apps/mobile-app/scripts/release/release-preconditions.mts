export type ReleaseGit = {
  hasTrackedChanges(): boolean;
  remoteBranchesContainingHead(): readonly string[];
};

export type UploadKeyStore = {
  keystorePath: string;
  keychainItemDescription: string;
  hasKeystore(): boolean;
  hasKeychainItem(): boolean;
};

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
  try {
    if (!uploadKey.hasKeychainItem()) {
      failures.push(`The upload key's password, ${uploadKey.keychainItemDescription}, is missing.`);
    }
  } catch (error) {
    failures.push(
      `Looking up the upload key's password, ${uploadKey.keychainItemDescription}, failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return failures;
}
