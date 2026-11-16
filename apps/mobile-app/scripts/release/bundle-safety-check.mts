/*
 * The bundle safety check: what proves a release bundle is safe to hand to testers (#438). It reads the
 * merged release manifest Gradle writes as plain XML, because the bundle holds the manifest as
 * protobuf, and the bundle's own zip entries, with Node's zlib and no extra tools.
 */
import zlib from "node:zlib";

/** The mobile E2E suite's debug hooks (`android/app/src/debug`), as dex class descriptors. */
const DEBUG_CLASS_DESCRIPTORS = [
  "Laudio/cup/app/FakeGoogleSignInPlugin;",
  "Laudio/cup/app/TestApiOrigin;",
  "Laudio/cup/app/TestApiOriginPlugin;",
];
const DEBUG_APPLICATION_CLASS = "DebugApplication";

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06_05_4b_50;
const END_OF_CENTRAL_DIRECTORY_LENGTH = 22;
const MAX_ZIP_COMMENT_LENGTH = 0xff_ff;
const CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02_01_4b_50;
const LOCAL_HEADER_SIGNATURE = 0x04_03_4b_50;
const ZIP64_MARKER = 0xff_ff_ff_ff;
const STORED = 0;
const DEFLATED = 8;

/**
 * Returns a message for every violation: debug networking or the debug application class in the
 * manifest, a debug hook's class in any dex, and any native library. Empty when the bundle is
 * safe.
 */
export function findBundleViolations({
  manifestXml,
  bundle,
}: {
  manifestXml: string;
  bundle: Buffer;
}): string[] {
  const violations = findManifestViolations(manifestXml);

  for (const entry of readZipEntries(bundle)) {
    if (entry.name.endsWith(".dex")) {
      const dex = entry.read();
      for (const descriptor of DEBUG_CLASS_DESCRIPTORS) {
        if (dex.includes(descriptor)) {
          violations.push(
            `The debug class ${classNameOf(descriptor)} is in ${entry.name}; debug hooks must stay in the debug source set.`,
          );
        }
      }
    }
    if (entry.name.endsWith(".so")) {
      violations.push(
        `The native library ${entry.name} is in the bundle; native code must be 16 KB page-aligned before Play accepts it (#436).`,
      );
    }
  }

  return violations;
}

function findManifestViolations(manifestXml: string): string[] {
  const attributes = readApplicationAttributes(manifestXml);
  const violations: string[] = [];

  if (attributes.get("android:debuggable") === "true") {
    violations.push('The manifest sets android:debuggable="true".');
  }
  const networkSecurityConfig = attributes.get("android:networkSecurityConfig");
  if (networkSecurityConfig !== undefined) {
    violations.push(
      `The manifest sets android:networkSecurityConfig="${networkSecurityConfig}", which only debug builds use, to allow plain HTTP to localhost.`,
    );
  }
  if (attributes.get("android:usesCleartextTraffic") === "true") {
    violations.push('The manifest sets android:usesCleartextTraffic="true".');
  }
  const applicationClass = attributes.get("android:name");
  if (
    applicationClass === DEBUG_APPLICATION_CLASS ||
    applicationClass?.endsWith(`.${DEBUG_APPLICATION_CLASS}`) === true
  ) {
    violations.push(`The manifest's application class is the debug one, ${applicationClass}.`);
  }

  return violations;
}

function readApplicationAttributes(manifestXml: string): Map<string, string> {
  const withoutComments = manifestXml.replaceAll(/<!--[\s\S]*?-->/g, "");
  const applicationTag = /<application\b((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/.exec(
    withoutComments,
  );
  if (applicationTag === null) {
    throw new Error("The merged manifest has no <application> element to check.");
  }

  const attributes = new Map<string, string>();
  for (const match of (applicationTag[1] ?? "").matchAll(
    /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    attributes.set(match[1] ?? "", match[2] ?? match[3] ?? "");
  }
  return attributes;
}

/** `Laudio/cup/app/TestApiOrigin;` becomes `audio.cup.app.TestApiOrigin`. */
function classNameOf(descriptor: string): string {
  return descriptor.slice(1, -1).replaceAll("/", ".");
}

type ZipEntry = { name: string; read(): Buffer };

/**
 * Lists a zip archive's entries from its central directory; `read` inflates one on demand. Only
 * what Gradle's bundles use is supported: stored or deflated entries, no ZIP64, no encryption.
 */
function readZipEntries(zip: Buffer): ZipEntry[] {
  const endOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(endOffset + 10);
  const centralDirectoryOffset = zip.readUInt32LE(endOffset + 16);
  if (centralDirectoryOffset === ZIP64_MARKER) {
    throw new Error("The bundle is a ZIP64 archive, which the bundle safety check can't read.");
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) {
      throw new Error(`The bundle's zip central directory is corrupt at byte ${String(offset)}.`);
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (compressedSize === ZIP64_MARKER || localHeaderOffset === ZIP64_MARKER) {
      throw new Error(
        `The bundle's entry ${name} uses ZIP64, which the bundle safety check can't read.`,
      );
    }

    entries.push({
      name,
      read: () => readEntryData({ zip, name, method, compressedSize, localHeaderOffset }),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const lowestOffset = Math.max(
    0,
    zip.length - END_OF_CENTRAL_DIRECTORY_LENGTH - MAX_ZIP_COMMENT_LENGTH,
  );
  for (
    let offset = zip.length - END_OF_CENTRAL_DIRECTORY_LENGTH;
    offset >= lowestOffset;
    offset--
  ) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("The bundle is no zip archive: it has no end of central directory record.");
}

function readEntryData({
  zip,
  name,
  method,
  compressedSize,
  localHeaderOffset,
}: {
  zip: Buffer;
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}): Buffer {
  if (zip.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(
      `The bundle's entry ${name} has no local header where the central directory says.`,
    );
  }
  // The local header's name and extra field lengths can differ from the central directory's.
  const dataOffset =
    localHeaderOffset +
    30 +
    zip.readUInt16LE(localHeaderOffset + 26) +
    zip.readUInt16LE(localHeaderOffset + 28);
  const data = zip.subarray(dataOffset, dataOffset + compressedSize);

  if (method === STORED) {
    return data;
  }
  if (method === DEFLATED) {
    return zlib.inflateRawSync(data);
  }
  throw new Error(
    `The bundle's entry ${name} uses zip compression method ${String(method)}, which the bundle safety check can't read.`,
  );
}
