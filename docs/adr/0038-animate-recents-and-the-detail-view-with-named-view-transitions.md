---
status: accepted
---

# Animate Recents and the detail view with named view transitions only

Opening a track from Recents and going back from its detail view move the track's cover between the two screens in a View Transition that the router starts for the navigation ([web application](../architecture/web-app.md), [research](../research/recents-detail-view-transitions.md)). [cup-audio/cup#168](https://github.com/cup-audio/cup/pull/168) added the cover transition, [cup-audio/cup#170](https://github.com/cup-audio/cup/pull/170) kept the bottom bars in place without capturing the document ([research](../research/view-transition-sticky-position.md)), [cup-audio/cup#173](https://github.com/cup-audio/cup/pull/173) stopped the cover travelling far, and [cup-audio/cup#198](https://github.com/cup-audio/cup/pull/198) adjusted the navigation progress bar for WebKit. These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Only Recents to a detail view and back get a transition.** The router's view transition setting ([cover transition](../../apps/web-app/src/app/cover-transition.ts)) starts one for those navigations and none for any other. Browsers without view transition types get no transition at all, as the router would otherwise start a transition for every navigation.
- **One cover name, only while a cover transition runs.** One rule names that track's covers, and only while a cover transition runs: a second element with the same name would make the browser skip the whole transition. Each cover carries its conversion ID as a marker for the transition to find it ([view transition names](../../apps/web-app/src/app/view-transition-names.ts)). The router asks for the transition before it commits the navigation, so the lookup finds the old screen's cover.
- **Cross-fade instead of moving the cover** when the cover starts outside the viewport, because it would cross a long distance within the transition's short duration, and, both ways, for a detail view opened from the mini player (the `isOpenedFromMiniPlayer` history state, set by the mini player's link): the press came from the pill, and its card can be anywhere on Recents.
- **No transition after an iOS swipe-back.** A swipe-back on iOS Safari already animates the page; a second animation would replay it.
- **The document is not captured.** The root has `view-transition-name: none` ([global styles](../../apps/web-app/src/app/global-styles.ts)), so only named elements animate, which each screen's content is too. While the document is captured, the browser measures sticky positions against the snapshot, which extends under a bottom browser toolbar, and would draw the bottom bars that much lower.
- **Each screen's content has a name of its own**, so the old screen fades out where it was and the new one fades in where it lands. A shared name would slide them by the difference in scroll position.
- **Both screens' bottom bars share a name**, so they cross-fade as a pair, which stays opaque where they overlap. Two separate fades would let the page's text show through the half-transparent bars. The bars differ in height and both end at the bottom of the screen, so their snapshots are anchored at the bottom.
- **The bottom bar's content carries the bar's name, not the bar.** The content of a sticky bottom bar takes the shared name during a view transition, for a snapshot of its own that the global styles draw above a moving cover ([fade footer](../../apps/web-app/src/app/components/fade-footer.ts), [cup-audio/cup#172](https://github.com/cup-audio/cup/pull/172)). The name stays off the bar itself, because iOS Safari cuts the snapshot of a `position: sticky` element by the page's scroll position, so that a bar on a scrolled page would show cut off or not at all, then appear when the transition ends.
- **Stacking.** The moving cover's group sits above the screens' content, whose sticky header would otherwise paint over it, and the bottom bars' group above the cover, which passes under them.
- **A card's cover has its own corners.** It is square on top and has the card's inner radius below ([cover image](../../apps/web-app/src/app/design-system/cover-image.tsx)), because a view transition's snapshot leaves out a container's clip.
- **The progress bar waits for the capture.** The router starts a View Transition only once the next screen has loaded, but stays pending until the browser has captured the old screen, which can take longer than the progress bar's delay; that wait is not loading, so the [navigation progress bar](../../apps/web-app/src/app/components/navigation-progress-bar.tsx) does not show while the router waits on that capture.

## Consequences

- Every other navigation, and every browser without view transition types, changes screens without animation.
- A new screen that should take part must name its content and its bottom bar, and must not name a cover outside the running transition.
