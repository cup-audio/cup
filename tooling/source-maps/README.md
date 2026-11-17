# Source maps

`prepare-source-maps` prepares a build output's source maps for Sentry, and [`upload-shell-symbols`](#upload-shell-symbols) uploads a shell release's symbols. The web app's and the Worker's `turbo:build` run it right after `vite build`; [release tracking](../../docs/architecture/observability-operations.md#release-tracking) describes how the deploy uploads the result.

## Usage

```sh
prepare-source-maps --build-dir ./dist/web --source-map-dir ./dist/source-maps
```

Paths resolve from the current working directory. The CLI:

1. fails when the build output holds no `.map` file, because the Vite build then lacks `build.sourcemap: "hidden"`;
2. runs `sentry-cli sourcemaps inject` on the build output, which writes a debug ID into every JavaScript file and into the source map next to it. Sentry CLI derives each ID from the file's content, so an unchanged build gets the same IDs and Turbo can replay it;
3. empties the source map directory and moves every `.map` file of the build output into it, at the same relative path.

The injection needs no Sentry token and sends nothing. Its executable runs directly from TypeScript source through Node's type stripping.

## upload-shell-symbols

The mobile app's `symbols:upload` runs this second CLI after a release archive of a shell and before its store upload; the [native release guide](../../docs/production-configuration.md#native-release) describes the release steps.

```sh
upload-shell-symbols --web-source-map-dir <dir> --android-web-dir <dir> ios <archive.xcarchive>
upload-shell-symbols --web-source-map-dir <dir> --android-web-dir <dir> android
```

The packed web bundle is the archive's `Products/Applications/<app>.app/public` for iOS and the `--android-web-dir` for Android. The CLI:

1. fails unless the debug ID of every source map in `--web-source-map-dir` is in a chunk of the packed web bundle, so the maps belong to the bundle the release ships;
2. for iOS, fails when the archive's `dSYMs` folder holds no dSYM;
3. runs `sentry-cli info`, which fails without the upload token;
4. for iOS, runs `sentry-cli debug-files upload --project cup-app --wait` on the archive's `dSYMs`;
5. runs `sentry-cli sourcemaps upload --project cup-app --strict` on the packed bundle and the source maps.

The first failing step ends it with exit code 1 and a message saying not to upload the build to the store. Sentry CLI runs with the caller's environment, so it reads the upload token from `~/.sentryclirc` and the organisation and region from the committed `.sentryclirc`. The tests run it with a fake token against a local server that fails every upload, in an empty home directory.

## Validation

To validate this package, run `pnpm --filter @cup/source-maps build` and `pnpm --filter @cup/source-maps test`.
