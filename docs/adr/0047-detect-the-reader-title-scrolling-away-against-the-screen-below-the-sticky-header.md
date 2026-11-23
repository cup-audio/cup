---
status: accepted
---

# Detect the reader title scrolling away against the screen below the sticky header

The detail view's top bar reacts when the audiobook's title scrolls away under it. The document scrolls rather than the shell's `<main>`, the header is sticky, and a large cover on a short screen can push the title below the visible part of the page before the listener scrolls at all. [cup-audio/cup#101](https://github.com/cup-audio/cup/pull/101) introduced the title observer, and the commit "fix(web-app): scroll the document instead of the shell's `<main>`" moved its root to the document. These decisions were recorded from code comments on 2026-11-23.

## Decision

- The [detail view](../../apps/web-app/src/routes/_shell.audiobooks.$conversionId.tsx) observes the title with an `IntersectionObserver` whose root is the screen without the sticky header on top of it, a top margin of minus the header's height, so only a title under or above the header counts as scrolled away.
- The root reaches far below the screen, with a bottom margin far more than any screen (`TITLE_OBSERVER_BOTTOM_MARGIN_PIXELS`), so a title that starts below the visible part, as under a large cover on a short screen, counts as intersecting and never as gone.
- The title is the narration document's first unit: every narration document opens with its title, which is narrated too.

## Consequences

- The observer's top margin depends on the shell header carrying `data-shell-header`.
- A narration document without a title unit fails an assertion instead of silently never reporting the title as gone.
