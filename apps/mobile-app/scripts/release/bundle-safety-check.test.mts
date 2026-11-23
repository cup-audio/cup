import { expect, test } from "vitest";

import { findBundleViolations } from "#scripts/release/bundle-safety-check.mts";
import { createZip, type ZipEntryFixture } from "#scripts/release/zip-fixture.mts";

const CLEAN_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="audio.cup.app">
    <!-- <application android:debuggable="true"> in a comment doesn't count. -->
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:theme="@style/AppTheme" >
        <activity android:name="audio.cup.app.MainActivity" android:exported="true" />
    </application>
</manifest>
`;

const DEBUG_CLASS_NAMES = [
  "audio.cup.app.FakeGoogleSignInPlugin",
  "audio.cup.app.TestApiOrigin",
  "audio.cup.app.TestApiOriginPlugin",
  "audio.cup.app.TestSentryDsn",
];

const R8_MAPPING_ENTRY = "BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map";

const CLEAN_DEX = dexContaining([
  "Laudio/cup/app/MainActivity;",
  "Laudio/cup/app/AndroidSharePlugin;",
]);

const CLEAN_ENTRIES: ZipEntryFixture[] = [
  { name: "BundleConfig.pb", data: Buffer.from("config") },
  { name: "base/manifest/AndroidManifest.xml", data: Buffer.from("protobuf manifest") },
  { name: "base/dex/classes.dex", data: CLEAN_DEX },
  { name: "base/assets/public/index.html", data: Buffer.from("<!doctype html>") },
];

test("a clean bundle passes", () => {
  expect(
    findBundleViolations({
      debugClassNames: DEBUG_CLASS_NAMES,
      manifestXml: CLEAN_MANIFEST,
      bundle: createZip(CLEAN_ENTRIES),
    }),
  ).toEqual([]);
});

test("a stored, uncompressed dex is read too", () => {
  const bundle = createZip([
    {
      name: "base/dex/classes.dex",
      data: dexContaining(["Laudio/cup/app/TestApiOrigin;"]),
      isStored: true,
    },
  ]);

  const violations = findBundleViolations({
    debugClassNames: DEBUG_CLASS_NAMES,
    manifestXml: CLEAN_MANIFEST,
    bundle,
  });

  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain("audio.cup.app.TestApiOrigin");
});

test("a debuggable application is reported", () => {
  const violations = findBundleViolations({
    debugClassNames: DEBUG_CLASS_NAMES,
    manifestXml: withApplicationAttribute('android:debuggable="true"'),
    bundle: createZip(CLEAN_ENTRIES),
  });

  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatch(/debuggable/);
});

test("debuggable set to false passes", () => {
  expect(
    findBundleViolations({
      debugClassNames: DEBUG_CLASS_NAMES,
      manifestXml: withApplicationAttribute('android:debuggable="false"'),
      bundle: createZip(CLEAN_ENTRIES),
    }),
  ).toEqual([]);
});

test("a network security config is reported", () => {
  const violations = findBundleViolations({
    debugClassNames: DEBUG_CLASS_NAMES,
    manifestXml: withApplicationAttribute(
      'android:networkSecurityConfig="@xml/network_security_config"',
    ),
    bundle: createZip(CLEAN_ENTRIES),
  });

  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatch(/networkSecurityConfig/);
});

test("permitted cleartext traffic is reported", () => {
  const violations = findBundleViolations({
    debugClassNames: DEBUG_CLASS_NAMES,
    manifestXml: withApplicationAttribute('android:usesCleartextTraffic="true"'),
    bundle: createZip(CLEAN_ENTRIES),
  });

  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatch(/usesCleartextTraffic/);
});

test("the debug application class is reported", () => {
  const violations = findBundleViolations({
    debugClassNames: DEBUG_CLASS_NAMES,
    manifestXml: withApplicationAttribute('android:name="audio.cup.app.DebugApplication"'),
    bundle: createZip(CLEAN_ENTRIES),
  });

  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatch(/DebugApplication/);
});

test.each(["FakeGoogleSignInPlugin", "TestApiOrigin", "TestApiOriginPlugin", "TestSentryDsn"])(
  "a dex containing %s is reported",
  (className) => {
    const bundle = createZip([
      ...CLEAN_ENTRIES,
      {
        name: "base/dex/classes2.dex",
        data: dexContaining([`Laudio/cup/app/${className};`]),
      },
    ]);

    const violations = findBundleViolations({
      debugClassNames: DEBUG_CLASS_NAMES,
      manifestXml: CLEAN_MANIFEST,
      bundle,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(`audio.cup.app.${className} `);
    expect(violations[0]).toContain("base/dex/classes2.dex");
  },
);

test("a debug class the caller doesn't name is not looked for", () => {
  const bundle = createZip([
    ...CLEAN_ENTRIES,
    { name: "base/dex/classes2.dex", data: dexContaining(["Laudio/cup/app/TestSentryDsn;"]) },
  ]);

  expect(
    findBundleViolations({
      debugClassNames: ["audio.cup.app.TestApiOrigin"],
      manifestXml: CLEAN_MANIFEST,
      bundle,
    }),
  ).toEqual([]);
});

test("an empty list of debug classes fails, because the command found no debug source set", () => {
  expect(() =>
    findBundleViolations({
      debugClassNames: [],
      manifestXml: CLEAN_MANIFEST,
      bundle: createZip(CLEAN_ENTRIES),
    }),
  ).toThrow(/debug class/);
});

test("a native library is reported", () => {
  const bundle = createZip([
    ...CLEAN_ENTRIES,
    { name: "base/lib/arm64-v8a/libnative.so", data: Buffer.from("ELF") },
  ]);

  const violations = findBundleViolations({
    debugClassNames: DEBUG_CLASS_NAMES,
    manifestXml: CLEAN_MANIFEST,
    bundle,
  });

  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain("base/lib/arm64-v8a/libnative.so");
});

test.each(["FakeGoogleSignInPlugin", "TestApiOrigin", "TestApiOriginPlugin", "TestSentryDsn"])(
  "R8's mapping file naming %s as an original class is reported",
  (className) => {
    const bundle = createZip([
      ...CLEAN_ENTRIES,
      {
        name: R8_MAPPING_ENTRY,
        data: Buffer.from(
          `# compiler: R8\naudio.cup.app.MainActivity -> audio.cup.app.MainActivity:\naudio.cup.app.${className} -> a.b:\n    void <init>() -> <init>\n`,
        ),
      },
    ]);

    const violations = findBundleViolations({
      debugClassNames: DEBUG_CLASS_NAMES,
      manifestXml: CLEAN_MANIFEST,
      bundle,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(`audio.cup.app.${className} `);
    expect(violations[0]).toContain(R8_MAPPING_ENTRY);
  },
);

test("R8's mapping file naming no debug class passes", () => {
  const bundle = createZip([
    ...CLEAN_ENTRIES,
    {
      name: R8_MAPPING_ENTRY,
      data: Buffer.from(
        "# compiler: R8\naudio.cup.app.MainActivity -> audio.cup.app.MainActivity:\n    audio.cup.app.TestApiOrigin origin -> a\n",
      ),
    },
  ]);

  expect(
    findBundleViolations({
      debugClassNames: DEBUG_CLASS_NAMES,
      manifestXml: CLEAN_MANIFEST,
      bundle,
    }),
  ).toEqual([]);
});

test("a debug class name in an entry that is neither dex nor R8's mapping file is ignored", () => {
  const bundle = createZip([
    ...CLEAN_ENTRIES,
    {
      name: "base/assets/public/notes.txt",
      data: Buffer.from(
        "Laudio/cup/app/FakeGoogleSignInPlugin; audio.cup.app.TestApiOriginPlugin -> a.b:",
      ),
    },
  ]);

  expect(
    findBundleViolations({
      debugClassNames: DEBUG_CLASS_NAMES,
      manifestXml: CLEAN_MANIFEST,
      bundle,
    }),
  ).toEqual([]);
});

test("every violation is reported at once", () => {
  const manifestXml = withApplicationAttribute(
    'android:name="audio.cup.app.DebugApplication" android:debuggable="true" android:networkSecurityConfig="@xml/network_security_config" android:usesCleartextTraffic="true"',
  );
  const bundle = createZip([
    ...CLEAN_ENTRIES,
    {
      name: "base/dex/classes2.dex",
      data: dexContaining([
        "Laudio/cup/app/FakeGoogleSignInPlugin;",
        "Laudio/cup/app/TestApiOrigin;",
        "Laudio/cup/app/TestApiOriginPlugin;",
      ]),
    },
    { name: R8_MAPPING_ENTRY, data: Buffer.from("audio.cup.app.TestApiOrigin -> a.b:\n") },
    { name: "base/lib/x86_64/libone.so", data: Buffer.from("ELF") },
    { name: "base/lib/arm64-v8a/libtwo.so", data: Buffer.from("ELF") },
  ]);

  expect(
    findBundleViolations({ debugClassNames: DEBUG_CLASS_NAMES, manifestXml, bundle }),
  ).toHaveLength(10);
});

test("a manifest without an application element fails", () => {
  expect(() =>
    findBundleViolations({
      debugClassNames: DEBUG_CLASS_NAMES,
      manifestXml: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" />',
      bundle: createZip(CLEAN_ENTRIES),
    }),
  ).toThrow(/application/);
});

test("a file that isn't a zip archive fails", () => {
  expect(() =>
    findBundleViolations({
      debugClassNames: DEBUG_CLASS_NAMES,
      manifestXml: CLEAN_MANIFEST,
      bundle: Buffer.from("not a zip"),
    }),
  ).toThrow(/zip/i);
});

function withApplicationAttribute(attribute: string): string {
  return CLEAN_MANIFEST.replace(
    'android:allowBackup="true"',
    `android:allowBackup="true"\n        ${attribute}`,
  );
}

function dexContaining(classDescriptors: readonly string[]): Buffer {
  return Buffer.concat([
    Buffer.from("dex\n035\0"),
    ...classDescriptors.map((descriptor) =>
      Buffer.concat([Buffer.from([descriptor.length]), Buffer.from(descriptor), Buffer.from([0])]),
    ),
  ]);
}
