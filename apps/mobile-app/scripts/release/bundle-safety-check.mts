/*
 * The bundle safety check: what proves a release bundle is safe to hand to testers (#438). It reads the
 * merged release manifest Gradle writes as plain XML, because the bundle holds the manifest as
 * protobuf, and the bundle's own zip entries, with Node's zlib and no extra tools.
 */
import { readZipEntries } from "#scripts/release/bundle-zip.mts";

const DEBUG_APPLICATION_CLASS = "DebugApplication";
/**
 * R8's mapping file, which AGP embeds in the bundle. R8 may rename a debug class that no keep rule
 * covers, such as `TestApiOrigin`, so its dex descriptor changes; the mapping still lists it under
 * its original name.
 */
const R8_MAPPING_ENTRY = "BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map";

/**
 * Returns a message for every violation: debug networking or the debug application class in the
 * manifest, one of `debugClassNames` (the debug source set's classes, fully qualified, such as the
 * mobile E2E suite's hooks) in any dex or as an original class in R8's mapping file, and any native
 * library. Empty when the bundle is safe.
 */
export function findBundleViolations({
  debugClassNames,
  manifestXml,
  bundle,
}: {
  debugClassNames: readonly string[];
  manifestXml: string;
  bundle: Buffer;
}): string[] {
  if (debugClassNames.length === 0) {
    throw new Error(
      "No debug class to look for: the debug source set should hold at least the mobile E2E suite's hooks.",
    );
  }
  const violations = findManifestViolations(manifestXml);

  for (const entry of readZipEntries(bundle)) {
    if (entry.name.endsWith(".dex")) {
      const dex = entry.read();
      for (const className of debugClassNames) {
        if (dex.includes(descriptorOf(className))) {
          violations.push(
            `The debug class ${className} is in ${entry.name}; debug hooks must stay in the debug source set.`,
          );
        }
      }
    }
    if (entry.name === R8_MAPPING_ENTRY) {
      const mappedClassNames = readOriginalClassNames(entry.read().toString("utf8"));
      for (const className of debugClassNames) {
        if (mappedClassNames.has(className)) {
          violations.push(
            `The debug class ${className} is in R8's mapping file ${entry.name}, so the bundle's code contains it, possibly renamed; debug hooks must stay in the debug source set.`,
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

/**
 * Reads the original class names from an R8 mapping file, whose class lines read `original.Name ->
 * obfuscated.Name:` and whose member lines are indented.
 */
function readOriginalClassNames(mapping: string): Set<string> {
  const classNames = new Set<string>();
  for (const match of mapping.matchAll(/^([^\s#][^\s]*) -> [^\s]+:$/gm)) {
    classNames.add(match[1] ?? "");
  }
  return classNames;
}

/** `audio.cup.app.TestApiOrigin` becomes the dex class descriptor `Laudio/cup/app/TestApiOrigin;`. */
function descriptorOf(className: string): string {
  return `L${className.replaceAll(".", "/")};`;
}
