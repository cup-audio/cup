---
status: accepted
---

# Shape the app E2E suite around browser and Playwright behaviour

The app E2E suite runs the production build against the real Worker in Chromium and WebKit ([#198](https://github.com/cup-audio/cup/pull/198)) and was made faster and replayable in [#312](https://github.com/cup-audio/cup/pull/312). Several of its choices answer engine, Playwright or Vite behaviour rather than app behaviour; others rely on properties of the deterministic fakes. They come from those changes, from the single narration track ([#73](https://github.com/cup-audio/cup/pull/73)) and from navigating without loading flashes ([#165](https://github.com/cup-audio/cup/pull/165)). These decisions were recorded from code comments on 2026-11-23.

## Decision

Configuration ([playwright.config.ts](../../qa/e2e/playwright.config.ts)):

- 8 workers: they passed three consecutive runs and were the fastest on an M4 Max; 10 and 12 were slower and 14 timed out (README, "Runtime").
- `defineConfig` replaces rather than merges `globalSetup`, so the shared configuration's Docker server setup is listed again next to the suite's own.

Browser behaviour:

- WebKit rejects the outgoing document's pending loads when a navigation replaces it: it raises each cancelled fetch as failing "due to access control checks", and the queries' error boundaries and Vite's preload helper log errors nobody can see. Chromium drops that document's pending loads silently. The console check in [fixtures.ts](../../qa/e2e/test-e2e/fixtures.ts) therefore attaches errors logged between a main-frame document request and the commit of the next document to the report without counting them, since they come from the outgoing document (the next one has run no script yet). Chromium keeps the full check. A test may expect an error when its route answers a request, before the browser logs it.
- Playwright's WebKit cannot fulfill a route with a redirect status, and the old origins can only be emulated by fulfilling their route with the Worker's 308, so the redirect test in [routing.test.ts](../../qa/e2e/test-e2e/routing.test.ts) runs in Chromium alone. That a redirect keeps the URL fragment is specified by the Fetch Standard.
- Five sign-ins and two conversions take longer than the default 30 seconds in WebKit, so [accounts.test.ts](../../qa/e2e/test-e2e/accounts.test.ts) raises that test's timeout to 60 seconds.
- The detail view's Back link preloads its route once in view, and a conversion failure can arrive at once, so the link may still be preloading; a Worker restart would refuse that chunk, so the recovery tests in [conversion.test.ts](../../qa/e2e/test-e2e/conversion.test.ts) wait for `networkidle` before restarting the Worker.
- The player host never attaches its audio element to the document, so [narration-audio.ts](../../qa/e2e/test-e2e/narration-audio.ts) keeps it reachable from the test; the host creates it before any other audio element.
- The account dialog keeps its own URL, so a Google sign-in to confirm a change returns to it.
- React logs one failed request twice when the error screen is in the route module rather than in a lazy chunk (the web app keeps error screens out of lazy route chunks), so a test expecting that error expects it twice.
- A test confirms deleting a track only once the covers on Recents behind the dialog have loaded: the account would refuse a deletion while one is still loading, and a listener takes far longer to confirm than a test.

Playwright tricks the tests rely on:

- The suite's `expect` ([fixtures.ts](../../qa/e2e/test-e2e/fixtures.ts)) makes `toHaveScreenshot` fail in a test without the visual tag, so a screenshot cannot silently lose the two browser projects that run only visual tests ([ADR 0025](0025-run-only-visual-component-tests-in-all-four-browser-projects.md)). Its type joins Playwright's two `toHaveScreenshot` overloads, for a page and for a locator: `expect` of a `Locator | Page` is a union of page and locator assertions, whose overloaded methods TypeScript cannot call, and both are assignable to one type whose options are the page's, a superset of the locator's.
- Playwright rejects a negative `maxDiffPixels` before it takes or compares a screenshot, so [visual-tag.test.ts](../../qa/e2e/test-e2e/visual-tag.test.ts) can fail an assertion that way only if the options reach it, with or without a name.
- The [loading state recorder](../../qa/loading-state-recorder/src/loading-state-recorder.ts) records every element marked as a loading state (`data-loading-state`) or as the navigation's progress bar (`data-pending-signal`) that the page shows, however briefly: its observer sees an element inserted and removed within one task, and marked descendants of an added subtree. It must be installed before the page navigates or mounts a story, because the record starts empty on each document. Its timestamps are `performance.now()`, which follows an installed Playwright clock. An element and its ancestors added in one task each show up as added nodes, and by the time the observer runs every ancestor's subtree contains it, so the recorder counts each element once per batch.
- The UI gallery guards each rule of the loading model in the development build under Strict Mode; [navigation.test.ts](../../qa/e2e/test-e2e/navigation.test.ts) guards the production build against the real Worker, where React mounts each screen once. To prove the query cache is kept for the page lifetime ([ADR 0016](0016-keep-the-query-cache-for-the-page-lifetime-and-load-screens-in-route-loaders.md)), the journey stays away from a screen longer than Query keeps an unobserved query at the least (one second for a suspense query), so a cache that did not keep it would have dropped it.

Deterministic fakes:

- Every frame of the fake speech is 24 ms and 384 bytes, so the joined segments form one valid MP3 ([artifacts.ts](../../qa/e2e/test-e2e/artifacts.ts)), and because every frame lasts a whole number of milliseconds, the joined track's encoded duration is the sum of the segments' encoded durations ([duration-allowance.test.ts](../../qa/e2e/test-e2e/duration-allowance.test.ts)).

## Consequences

- WebKit runs keep a weaker console check than Chromium for the moment a navigation replaces a document.
- The redirect-from-old-origin journey is covered in Chromium only.
- Changing the fake speech's frame size or duration breaks the MP3 join and duration assertions.
- Raising the worker count needs a new measurement on the operator's machine.
