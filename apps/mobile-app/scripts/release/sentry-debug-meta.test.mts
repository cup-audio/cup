import { expect, test } from "vitest";

import { readProguardUuid } from "#scripts/release/sentry-debug-meta.mts";
import { createZip } from "#scripts/release/zip-fixture.mts";

const UUID = "80b30bae-4ec7-55af-924e-8346c364062d";
const DEBUG_META_ENTRY = "base/assets/sentry-debug-meta.properties";

test("reads the ProGuard UUID the build embedded in the bundle's Sentry debug meta asset", () => {
  const bundle = createZip([
    { name: "base/dex/classes.dex", data: Buffer.from("dex") },
    { name: DEBUG_META_ENTRY, data: Buffer.from(`io.sentry.ProguardUuids=${UUID}\n`) },
  ]);

  expect(readProguardUuid(bundle)).toBe(UUID);
});

test("a bundle without the asset fails, since Sentry could not deobfuscate its events", () => {
  const bundle = createZip([{ name: "base/dex/classes.dex", data: Buffer.from("dex") }]);

  expect(() => readProguardUuid(bundle)).toThrow(
    `The bundle has no ${DEBUG_META_ENTRY} with a ProGuard UUID`,
  );
});

test("an asset without exactly one UUID fails", () => {
  for (const content of [
    "io.sentry.ProguardUuids=\n",
    `io.sentry.ProguardUuids=${UUID}|${UUID}\n`,
  ]) {
    const bundle = createZip([{ name: DEBUG_META_ENTRY, data: Buffer.from(content) }]);

    expect(() => readProguardUuid(bundle)).toThrow(
      `The bundle has no ${DEBUG_META_ENTRY} with a ProGuard UUID`,
    );
  }
});
