import { Temporal } from "temporal-polyfill";
import { expect, test } from "vitest";

import { deriveReleaseVersion, formatReleaseName } from "#scripts/release/release-version.mts";

test("ADR 0032's example: 2026-11-14 at 13:50 UTC is versionCode 457310", () => {
  expect(deriveReleaseVersion(Temporal.Instant.from("2026-11-14T13:50:00Z"))).toEqual({
    versionCode: 457_310,
    versionName: "2026.11.14",
  });
});

test("the epoch itself is versionCode 0", () => {
  expect(deriveReleaseVersion(Temporal.Instant.from("2026-01-01T00:00:00Z"))).toEqual({
    versionCode: 0,
    versionName: "2026.01.01",
  });
});

test("versionName zero-pads month and day", () => {
  expect(deriveReleaseVersion(Temporal.Instant.from("2026-05-08T09:00:00Z")).versionName).toBe(
    "2026.05.08",
  );
});

test("the last second of a minute still counts as that minute", () => {
  expect(deriveReleaseVersion(Temporal.Instant.from("2026-01-01T00:01:59.999Z")).versionCode).toBe(
    1,
  );
  expect(deriveReleaseVersion(Temporal.Instant.from("2026-01-01T00:02:00Z")).versionCode).toBe(2);
});

test("versionName is the UTC date, not the local one", () => {
  expect(deriveReleaseVersion(Temporal.Instant.from("2026-11-14T23:30:00-02:00")).versionName).toBe(
    "2026.11.15",
  );
});

test("an instant before the epoch is refused", () => {
  expect(() => deriveReleaseVersion(Temporal.Instant.from("2025-12-31T23:59:59Z"))).toThrow(
    /before the version epoch/,
  );
});

test("the release name is the versionName and the 7-character short SHA", () => {
  expect(formatReleaseName("2026.11.14", "8e5c815d1ec6f0e4b3bb1a1c3f7b0a4d2e9f6c1a")).toBe(
    "2026.11.14 (8e5c815)",
  );
});

test("the release name refuses anything but a full commit SHA", () => {
  expect(() => formatReleaseName("2026.11.14", "8e5c815")).toThrow(/40-character/);
});
