# Source maps

This CLI prepares a build output's source maps for Sentry. The web app's and the Worker's `turbo:build` run it right after `vite build`; [release tracking](../../docs/architecture/observability.md#release-tracking) describes how the deploy uploads the result.

## Usage

```sh
prepare-source-maps --build-dir ./dist/web --source-map-dir ./dist/source-maps
```

Paths resolve from the current working directory. The CLI:

1. fails when the build output holds no `.map` file, because the Vite build then lacks `build.sourcemap: "hidden"`;
2. runs `sentry-cli sourcemaps inject` on the build output, which writes a debug ID into every JavaScript file and into the source map next to it. Sentry CLI derives each ID from the file's content, so an unchanged build gets the same IDs and Turbo can replay it;
3. empties the source map directory and moves every `.map` file of the build output into it, at the same relative path.

The injection needs no Sentry token and sends nothing. Its executable runs directly from TypeScript source through Node's type stripping.

## Validation

To validate this package, run `pnpm --filter @cup/source-maps build` and `pnpm --filter @cup/source-maps test`.
