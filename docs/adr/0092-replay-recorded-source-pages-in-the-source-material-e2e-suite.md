---
status: accepted
---

# Replay recorded source pages in the source-material E2E suite

The source-material E2E suite runs source preparation in a browser against real publisher pages. It replays locally hosted recordings since commit `1620b0fc`, runs in Docker Playwright since commit `ec2728fb`, and starts its server on an operating-system-assigned port since [cup-audio/cup#3](https://github.com/cup-audio/cup/pull/3). Unrecorded requests were listed for pages with randomly sampled requests in [cup-audio/cup#142](https://github.com/cup-audio/cup/pull/142). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Public URLs, local answers.** The [suite](../../libs/prepare-source-material/test-e2e/prepare-source-material.test.ts) retains public page URLs so production URL checks and relative resource resolution still run; only the test transport redirects requests to the local recording server. A cover image request the loader approved is answered locally instead of reaching the internet.
- **What is not loaded.** Images, fonts, media, and third-party tracking do not supply narration content and are not served. Each case lists the requests the recording does not answer: unavailable at capture time, with query values that change on every load, or made only on randomly sampled loads, such as Datadog session replay, which samples one load in five at random and only then loads its recorder. The page loads without them. The browser save holds only the scripts the page references, not the chunks they import.
- **No telemetry.** Every test whose page requests Sentry or the telemetry tunnel fails.
- **Port handshake.** The [source page server](../../libs/prepare-source-material/test-e2e/source-page-server.ts) listens on a port the operating system assigns, so concurrent runs cannot collide, and prints it on a line the [Playwright configuration](../../libs/prepare-source-material/playwright.config.ts) reads; Playwright exports the named capture group to the environment that workers read.
- **HTML baselines** stay beside the tests rather than using platform-specific image paths.

## Consequences

- A recording that starts making a new unrecorded request needs it listed in its case.
