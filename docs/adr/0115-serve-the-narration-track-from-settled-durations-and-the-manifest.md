---
status: accepted
---

# Serve the narration track from settled durations and audiobook files only through the manifest

[ADR 0011](0011-serve-one-narration-track-and-play-it-with-one-audio-element.md) decided to serve one narration track joined from the stored audio segments. How the listener API serves that track, the cover image and the narration source material was decided in [cup-audio/cup#73](https://github.com/cup-audio/cup/pull/73), [cup-audio/cup#5](https://github.com/cup-audio/cup/pull/5) (cover images), [cup-audio/cup#101](https://github.com/cup-audio/cup/pull/101) (preparation phases), [cup-audio/cup#502](https://github.com/cup-audio/cup/pull/502) (narration source material) and [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422) (fault reporting). These decisions were recorded from code comments on 2026-11-23. [Playback](../architecture/playback.md) and [R2 storage](../architecture/r2-storage.md) describe the surrounding architecture.

## Decision

The narration track ([serve audiobook](../../libs/api-server/src/http/serve-audiobook.ts)):

- The track is the stored audio segments, unchanged and joined in sequence order. Its layout comes from the owner's settled durations alone, so the manifest is never loaded, and HEAD and conditional requests read nothing from R2. Request authorization happens before.
- The [listener response](../../libs/api-server/src/http/listener-responses.ts) reports `durations`, the settled segment durations in sequence order. Each segment starts at the sum of the durations before it; the constant decoder delay at each join is not corrected for.
- Hono answers HEAD with the first matching route, which is the GET route.
- A stale `If-Range` gets the whole current track instead of a range of another version.
- Each part is read with a ranged R2 `get`. A part whose object is missing, or whose size differs from the length derived from its settled duration, is not served. That is a fault the operator must look at, so it opens a Sentry issue as well as writing the error log record with its sizes.
- The first part is streamed, and each further part is read only once the client has consumed the previous one, so a cancelled request stops reading from R2.

Other audiobook files:

- The cover image of a prepared audiobook is served only as its manifest records it: an object left by an earlier preparation attempt is not served. Request authorization happens before. Its browser caching is [ADR 0013](0013-cache-cover-images-in-the-browser-for-a-day.md).
- A new conversion's narration source material is read from the audio bucket only through the reference its manifest records ([narration source material reader](../../libs/api-server/src/adapters/narration-source-material-reader.ts)).

Preparation phases:

- Listeners see a preparation phase for the phase a pending conversion last started. Preparation never starts the audio segment production and audiobook assembly phases, since speech synthesis runs per segment after it, so those phases map to no listener phase.

Narration track HTTP details:

- The first part is read before the headers are sent, so a missing object yields an error status instead of a truncated success.
- Workers send a generic stream chunked and ignore a `Content-Length` header set for it, so the body is a `FixedLengthStream`, which keeps the declared length. Node, which runs the unit tests, has no `FixedLengthStream` and keeps the header as set.
- The track's strong ETag changes with the conversion or any segment's settled duration. `If-None-Match` uses the weak comparison and may list several tags or `*`.

## Consequences

- Serving the track depends on settled durations matching the stored objects' sizes; a mismatch shows up as an operator issue rather than corrupted audio.
- Players see small timing drift at segment joins from the uncorrected decoder delay.
