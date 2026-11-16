import zlib from "node:zlib";
import { expect, test } from "vitest";

import { findBundleViolations } from "#scripts/release/bundle-safety-check.mts";

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
    findBundleViolations({ manifestXml: CLEAN_MANIFEST, bundle: createZip(CLEAN_ENTRIES) }),
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

  const violations = findBundleViolations({ manifestXml: CLEAN_MANIFEST, bundle });

  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain("audio.cup.app.TestApiOrigin");
});

test("a debuggable application is reported", () => {
  const violations = findBundleViolations({
    manifestXml: withApplicationAttribute('android:debuggable="true"'),
    bundle: createZip(CLEAN_ENTRIES),
  });

  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatch(/debuggable/);
});

test("debuggable set to false passes", () => {
  expect(
    findBundleViolations({
      manifestXml: withApplicationAttribute('android:debuggable="false"'),
      bundle: createZip(CLEAN_ENTRIES),
    }),
  ).toEqual([]);
});

test("a network security config is reported", () => {
  const violations = findBundleViolations({
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
    manifestXml: withApplicationAttribute('android:usesCleartextTraffic="true"'),
    bundle: createZip(CLEAN_ENTRIES),
  });

  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatch(/usesCleartextTraffic/);
});

test("the debug application class is reported", () => {
  const violations = findBundleViolations({
    manifestXml: withApplicationAttribute('android:name="audio.cup.app.DebugApplication"'),
    bundle: createZip(CLEAN_ENTRIES),
  });

  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatch(/DebugApplication/);
});

test.each(["FakeGoogleSignInPlugin", "TestApiOrigin", "TestApiOriginPlugin"])(
  "a dex containing %s is reported",
  (className) => {
    const bundle = createZip([
      ...CLEAN_ENTRIES,
      {
        name: "base/dex/classes2.dex",
        data: dexContaining([`Laudio/cup/app/${className};`]),
      },
    ]);

    const violations = findBundleViolations({ manifestXml: CLEAN_MANIFEST, bundle });

    expect(violations).toHaveLength(1);
    // The trailing space tells `TestApiOrigin` apart from `TestApiOriginPlugin`.
    expect(violations[0]).toContain(`audio.cup.app.${className} `);
    expect(violations[0]).toContain("base/dex/classes2.dex");
  },
);

test("a native library is reported", () => {
  const bundle = createZip([
    ...CLEAN_ENTRIES,
    { name: "base/lib/arm64-v8a/libnative.so", data: Buffer.from("ELF") },
  ]);

  const violations = findBundleViolations({ manifestXml: CLEAN_MANIFEST, bundle });

  expect(violations).toHaveLength(1);
  expect(violations[0]).toContain("base/lib/arm64-v8a/libnative.so");
});

test("a debug class name in a non-dex entry is ignored", () => {
  const bundle = createZip([
    ...CLEAN_ENTRIES,
    {
      name: "base/assets/public/notes.txt",
      data: Buffer.from("Laudio/cup/app/FakeGoogleSignInPlugin; Laudio/cup/app/TestApiOrigin;"),
    },
    {
      name: "BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map",
      data: Buffer.from("audio.cup.app.TestApiOriginPlugin -> a.b:"),
    },
  ]);

  expect(findBundleViolations({ manifestXml: CLEAN_MANIFEST, bundle })).toEqual([]);
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
    { name: "base/lib/x86_64/libone.so", data: Buffer.from("ELF") },
    { name: "base/lib/arm64-v8a/libtwo.so", data: Buffer.from("ELF") },
  ]);

  expect(findBundleViolations({ manifestXml, bundle })).toHaveLength(9);
});

test("a manifest without an application element fails", () => {
  expect(() =>
    findBundleViolations({
      manifestXml: '<manifest xmlns:android="http://schemas.android.com/apk/res/android" />',
      bundle: createZip(CLEAN_ENTRIES),
    }),
  ).toThrow(/application/);
});

test("a file that isn't a zip archive fails", () => {
  expect(() =>
    findBundleViolations({ manifestXml: CLEAN_MANIFEST, bundle: Buffer.from("not a zip") }),
  ).toThrow(/zip/i);
});

type ZipEntryFixture = { name: string; data: Buffer; isStored?: boolean };

function withApplicationAttribute(attribute: string): string {
  return CLEAN_MANIFEST.replace(
    'android:allowBackup="true"',
    `android:allowBackup="true"\n        ${attribute}`,
  );
}

/** Stands in for a dex file: its string table holds class descriptors as plain bytes. */
function dexContaining(classDescriptors: readonly string[]): Buffer {
  return Buffer.concat([
    Buffer.from("dex\n035\0"),
    ...classDescriptors.map((descriptor) =>
      Buffer.concat([Buffer.from([descriptor.length]), Buffer.from(descriptor), Buffer.from([0])]),
    ),
  ]);
}

/** Writes a zip archive with deflated entries, unless an entry asks to be stored. */
function createZip(entries: readonly ZipEntryFixture[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const isStored = entry.isStored ?? false;
    const content = isStored ? entry.data : zlib.deflateRawSync(entry.data);
    const method = isStored ? 0 : 8;
    const crc = zlib.crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
}
