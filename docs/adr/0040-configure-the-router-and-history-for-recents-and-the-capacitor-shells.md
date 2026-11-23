---
status: accepted
---

# Configure the router and history for Recents and the Capacitor shells

The web app runs in browsers and, unchanged, in the Android and iOS Capacitor shells. [`createAppRouter`](../../apps/web-app/src/app/global-providers.tsx) and the helpers that leave a screen for Recents carry several non-obvious settings. They were introduced by [cup-audio/cup#101](https://github.com/cup-audio/cup/pull/101) (the Recents redesign, with the Add dialog route), [cup-audio/cup#116](https://github.com/cup-audio/cup/pull/116) (dialog routes over Recents), the change that made the document scroll instead of the shell's `<main>` (commit 8ee8896d), [cup-audio/cup#165](https://github.com/cup-audio/cup/pull/165) (navigate without loading flashes), [cup-audio/cup#168](https://github.com/cup-audio/cup/pull/168) (cover transition) and [cup-audio/cup#196](https://github.com/cup-audio/cup/pull/196) (render routes in the iOS app's `capacitor://` WebView). Pending timing and viewport preloading are [ADR 0016](0016-keep-the-query-cache-for-the-page-lifetime-and-load-screens-in-route-loaders.md)'s. These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Give the router an HTTP(S) origin in the iOS app.** The iOS app serves the web app from `capacitor://localhost`. The router resolves every path against its origin and treats a URL as external unless it is HTTP(S) with that same origin; a `capacitor:` URL is neither, and its origin parses as `"null"`. So every in-app location would count as external, and the router, which blocks document navigation to schemes outside its allowlist, would drop the first navigation silently and render no route. Any HTTP(S) origin keeps in-app paths internal; the router uses it only to parse and compare paths. A sandboxed document also reports the origin `"null"`, which is no URL to parse.
- **The document is the scroll container**, which the router restores and resets by default, so `scrollRestoration` needs nothing more.
- **The Add dialog route is masked.** `/recent/add` keeps the URL bar on `/recent`. A reload still opens the dialog, because the mask keeps `unmaskOnReload` false.
- **Return to Recents through history.** Every in-app link on Recents, to a dialog over it or a detail view, sets the `isOpenedFromRecents` history state, so leaving that screen goes back one history entry and Recents returns at its scroll position ([return to Recents](../../apps/web-app/src/app/return-to-recents.ts)). A share, a direct link or the return from a Google sign-in has no Recents entry below it, so leaving replaces the entry with `/recent`. Only accounts have Recents; trial listeners' Back returns to the start ([detail top bar](../../apps/web-app/src/app/components/detail-top-bar.tsx)).
- **One close per dialog route.** Several events can ask to close a dialog route over Recents, such as the Add dialog's Cancel and its successful start, but only one may move the history ([close Recents dialog](../../apps/web-app/src/app/use-close-recents-dialog.ts)). The system Back gesture leaves without closing, and the Add dialog's start can still succeed afterwards, so a close after the router has left the dialog does nothing.
- **The cover transition belongs to its router.** It looks up routes on the router it belongs to, so the router sets `defaultViewTransition` after it is created.
- **Story routers are created on first mount.** A story that needs a router renders as the root of a router of its own, created on first mount, because the component gallery evaluates every story module, also for other stories, and a router created then takes over theirs ([detail top bar story](../../apps/web-app/src/app/components/detail-top-bar.story.tsx)).

## Consequences

- In-app navigation works the same in `capacitor://`, `https://localhost` and the browser, at the cost of a placeholder origin that never reaches the network.
- Recents keeps its scroll position whenever it is below the current entry, and every exit path that lacks it lands on a fresh `/recent`.
