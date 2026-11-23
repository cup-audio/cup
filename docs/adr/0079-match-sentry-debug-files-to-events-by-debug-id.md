---
status: accepted
---

# Match Sentry debug files to events by debug ID

Production errors are symbolicated from source maps and native debug files ([ADR 0030](0030-observe-production-with-sentrys-own-sdks-and-turn-cloudflares-observability-off.md), [ADR 0031](0031-capture-native-crashes-in-the-shells-without-consent-keeping-no-installation-id-on-the-device.md)). The tooling in `tooling/source-maps` came with Sentry reporting ([#422](https://github.com/cup-audio/cup/pull/422), issue [#403](https://github.com/cup-audio/cup/issues/403)) and was extended for Android builds shipped through Google Play ([#449](https://github.com/cup-audio/cup/pull/449), CUP-80). These decisions were recorded from code comments on 2026-11-23.

## Decision

- [prepare-source-maps.ts](../../tooling/source-maps/src/prepare-source-maps.ts) injects a Sentry debug ID into every JavaScript file of a build output that is served, deployed or packed into the shells, and into its source map, then moves the source maps into a directory that is never served or deployed. The deploy uploads them from there ([deploy script](../../apps/cloudflare-worker/scripts/deploy.ts)). Rolldown emits its runtime helper without a source map; it still gets a debug ID. Sentry CLI derives each debug ID from the file's content, so an unchanged build injects the same IDs and stays cacheable. With `build.sourcemap: "hidden"` the chunks name no source map; the CLI finds each one next to its chunk. The injection is local: no update check or other request leaves the machine.
- [upload-shell-symbols.ts](../../tooling/source-maps/src/upload-shell-symbols.ts) uploads what Sentry needs to symbolicate a shell release: the iOS archive's dSYMs or the Android build's R8 mapping file, and the source maps of the web bundle packed into the build. On Android that is the bundle `cap sync` packed into the Android project, which the release build ships; Xcode archives the app at `Products/Applications/<name>.app`, and Capacitor packs the web bundle in its `public` folder. Capacitor adds its own scripts, which carry no debug ID. The source maps are those of the last web build in the checkout, which need not be the bundle `cap sync` packed into the release, and Sentry CLI would upload them anyway, so the tool checks that every map's debug ID is in the packed bundle.
- Debug IDs and ProGuard UUIDs, not releases, match the files to events, so no release is named. Sentry CLI uploads the mapping file under the UUID it derives from the content, which the check against the build's embedded UUID matched. Sentry deobfuscates an Android event only with the mapping file whose UUID the app carries, hence that check; Sentry CLI computes the UUID offline (`--no-upload` writes it into a properties file without contacting Sentry). Sentry CLI otherwise inherits the operator's environment, so it finds the upload token in `~/.sentryclirc` and the committed `.sentryclirc` above the working directory.
- The dSYM upload passes `--wait`, which waits until Sentry has processed the files, so a processing error fails the step too. Any failure throws before the operator uploads the build to the store.
- The upload tests run Sentry CLI with an empty home directory, which has no `~/.sentryclirc`, so the operator's upload token cannot be used; the token and the URL come from the same source, so Sentry CLI talks to the local server only.

## Consequences

- A shell build reaches a store only after its debug files are in Sentry.
- Source maps never ship with the web app or the shells.
- Events are symbolicated without any release naming, so release tracking is not needed for symbolication.
