/*
 * The version of a mobile release build, derived from its UTC build time (ADR 0029).
 */
import { Temporal } from "temporal-polyfill";

export type ReleaseVersion = {
  /** Whole minutes since {@link VERSION_EPOCH}. */
  versionCode: number;
  /** The UTC calendar date, `YYYY.MM.DD`. */
  versionName: string;
};

const VERSION_EPOCH = Temporal.Instant.from("2026-01-01T00:00:00Z");
const MILLISECONDS_PER_MINUTE = 60_000;
const SHORT_SHA_LENGTH = 7;

export function deriveReleaseVersion(buildTime: Temporal.Instant): ReleaseVersion {
  if (Temporal.Instant.compare(buildTime, VERSION_EPOCH) < 0) {
    throw new Error(
      `Cannot derive a release version from ${buildTime.toString()}, because it is before the version epoch ${VERSION_EPOCH.toString()}. Check the Mac's clock.`,
    );
  }

  const millisecondsSinceEpoch = buildTime.epochMilliseconds - VERSION_EPOCH.epochMilliseconds;
  const date = buildTime.toZonedDateTimeISO("UTC");
  const year = String(date.year);
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");

  return {
    versionCode: Math.floor(millisecondsSinceEpoch / MILLISECONDS_PER_MINUTE),
    versionName: `${year}.${month}.${day}`,
  };
}

/**
 * The Play release name, `<versionName> (<7-character short SHA>)`, which links a build to its
 * commit.
 */
export function formatReleaseName(versionName: string, commitSha: string): string {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error(`Expected a full 40-character commit SHA, got "${commitSha}".`);
  }
  return `${versionName} (${commitSha.slice(0, SHORT_SHA_LENGTH)})`;
}
