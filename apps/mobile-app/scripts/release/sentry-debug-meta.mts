import { readZipEntries } from "#scripts/release/bundle-zip.mts";

const DEBUG_META_ENTRY = "base/assets/sentry-debug-meta.properties";
const PROGUARD_UUIDS = /^io\.sentry\.ProguardUuids=([0-9a-f-]{36})\s*$/m;

export function readProguardUuid(bundle: Buffer): string {
  const entry = readZipEntries(bundle).find(({ name }) => name === DEBUG_META_ENTRY);
  const uuid = entry === undefined ? undefined : PROGUARD_UUIDS.exec(entry.read().toString("utf8"));
  if (uuid?.[1] === undefined) {
    throw new Error(
      `The bundle has no ${DEBUG_META_ENTRY} with a ProGuard UUID, so Sentry could not deobfuscate its events; the release build's generateReleaseSentryDebugMeta task writes it.`,
    );
  }

  return uuid[1];
}
