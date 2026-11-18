# Cup brand assets

Edit `assets/cup.svg` for the native app icons, splash screens, web favicon, touch/social icon, and Google Play store listing icon. `assets/cup-dark.svg` is the separate dark-mode web favicon. Keep their artwork coordinated when changing the logo.

`assets/outputs.json` defines raster output paths, sizes, padding through `markSize`, and transparency. Platform assets remain checked in so Xcode and Android Studio can build directly. Treat those generated files as outputs and edit the sources here. One output is read by no build: `apps/mobile-app/store-assets/google-play/app-icon-512.png` is the Google Play store listing icon, which the operator uploads by hand ([store listing icon](../../apps/mobile-app/README.md#store-listing-icon)). It currently renders the same as the web app's `cup-icon.png` but is a separate output, so that changing the web icon never changes the store listing unnoticed.

From the repository root:

```sh
pnpm brand-assets:sync
pnpm brand-assets:check
```

The root commands delegate to the `@cup/brand-assets` package and cover web, Android, and iOS assets together. The web and mobile apps consume the checked-in outputs without depending on the generator.

The web build and native sync use checked-in assets without regenerating them. Every [validation gate](../../AGENTS.md#validation-gates) checks assets without writing and reports stale paths with the repair command. Run `pnpm brand-assets:sync` after changing a source and review the generated changes before validation.

The generator also creates Android's `drawable-v24/ic_launcher_foreground.xml`. Its SVG-to-vector conversion supports paths with explicit six-digit hex fills and rejects unsupported SVG features. The raster renderer preserves the complete SVG. Extend vector conversion before introducing shapes or effects that Android cannot currently reproduce. The platform wrappers and white background resources remain native configuration.
