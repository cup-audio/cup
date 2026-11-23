---
status: accepted
---

# Save listening positions on the device or server and in the cached audiobook

Playback saves the listening position every few seconds. Listeners without an account have no server-side position, the Android app's native player saves positions itself, and an audiobook opened again before its refetch returns must still load at the latest position. The commit "feat(playback)!: prepare articles before progressive speech synthesis" introduced device-local positions, [cup-audio/cup#165](https://github.com/cup-audio/cup/pull/165) the cache handling of saves, and [cup-audio/cup#401](https://github.com/cup-audio/cup/pull/401) (issue [cup-audio/cup#392](https://github.com/cup-audio/cup/issues/392), CUP-41, CUP-71) the native player's positions. These decisions were recorded from code comments on 2026-11-23.

## Decision

- [`savePlaybackPosition`](../../apps/web-app/src/data-fetching/reader.ts) saves a position on the device for listeners without an account, and on the server and in the cached audiobook for signed-in ones, so an audiobook opened again before its refetch returns loads at this position.
- After a server save, the audiobook query is marked stale without being requested: playback saves every few seconds, and the cache already holds the position. The next page that shows the audiobook requests it again.
- `cachePlaybackPosition` writes a position the Android app's native player saved into the cached audiobook without a request. It neither cancels nor invalidates the audiobook's query, because the player renews its track URL through that query's data. The cached response keeps its arrival time, which dates its narration track URL.
- A corrupt device-local listening position reads as none, so it never makes the article unreadable.

## Consequences

- Saving a position never triggers a refetch of the audiobook.
- The cache's arrival time stays a reliable age for the signed narration track URL, even after position writes.
