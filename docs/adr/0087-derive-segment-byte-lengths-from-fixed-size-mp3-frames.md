---
status: accepted
---

# Derive segment byte lengths from fixed-size MP3 frames

Since [cup-audio/cup#73](https://github.com/cup-audio/cup/pull/73) ([ADR 0011](0011-serve-one-narration-track-and-play-it-with-one-audio-element.md)) the listener API serves one narration track built from the stored audio segments, so it must know each segment's byte length. The segment's settled duration is already recorded, and segment identity and metadata travel as R2 object metadata. These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Byte length follows from duration.** [`audio-format.ts`](../../libs/audiobook-production/src/audio-format.ts) derives a segment's byte length from its settled duration, `actual_milliseconds` × 16. The derivation holds because `analyzeMp3` accepts only unpadded MPEG-2 Layer III frames in `AUDIO_FORMAT`, each exactly 384 bytes and 24 ms long. The [audio format tests](../../libs/audiobook-production/test/audio-format.test.ts) reject a frame with bitrate index `0b1011`, which is 112 kbps in MPEG-2 Layer III and so 336 bytes, and a frame with the padding bit set, 385 bytes.
- **Frame checks.** Only MPEG-2 encodes 24 kHz, so the sample-rate check also rejects every other MPEG version, and `getSegmentByteLength` relies on the check that every frame has the same length.
- **Encoder frames.** LAME's encoder delay and its flush add two frames to every encoded segment, stretched or not ([produce audio segment test](../../libs/audiobook-production/test/produce-audio-segment.test.ts)).
- **Segment metadata within R2's limit.** [Audio segment storage](../../libs/audiobook-production/src/audio-segment-storage.ts) bounds the metadata by R2's 8,192-byte object metadata limit (<https://developers.cloudflare.com/r2/platform/limits/>). The narration text is stored as JSON, which preserves the exact input while keeping line breaks safe for metadata header transport.

## Consequences

- Any future change to the segment encoding must start recording segment byte lengths, because derivation then no longer holds for older tracks.
