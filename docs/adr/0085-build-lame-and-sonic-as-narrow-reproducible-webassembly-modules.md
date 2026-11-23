---
status: accepted
---

# Build LAME and Sonic as narrow, reproducible WebAssembly modules

The Worker encodes narration audio to MP3 with LAME, built into the [MP3 encoding library](../../libs/mp3-encoding/) since Cup's first release (commit `0ffeabca`), and time-stretches it with Sonic in the [time-stretching library](../../libs/time-stretching/) since [cup-audio/cup#281](https://github.com/cup-audio/cup/pull/281) ([ADR 0023](0023-time-stretch-narration-audio-after-synthesis-with-sonic.md)). Both are third-party C code compiled to WebAssembly from downloaded sources and called from JavaScript through a small C bridge. These decisions were recorded from code comments on 2026-11-23.

## Decision

### Build

[`build-encoder.sh`](../../libs/mp3-encoding/scripts/build-encoder.sh) and [`build-time-stretcher.sh`](../../libs/time-stretching/scripts/build-time-stretcher.sh) follow the same rules:

- Abort before publishing an artifact when a command fails or a variable is unset.
- Pin every external input by content, not a mutable version, branch, release or container tag. Pinning the output separately also detects toolchain or build-environment drift.
- Keep downloaded and generated files outside the repository until every check passes. The recursive cleanup target is always the exact directory returned by `mktemp`.
- Download on the host so the build container can run without network access. Verify the archive before `tar` parses it; extraction remains confined to the unique temporary directory.
- Container security model:
  - `--rm` removes the container and its anonymous cache volume after the build.
  - `--platform` fixes architecture-dependent output for reproducibility.
  - `--network none` prevents downloaded build code from contacting external services.
  - `--cap-drop ALL` and `no-new-privileges` remove privilege-escalation paths.
  - `--read-only` prevents changes to the pinned image filesystem.
  - The private `/tmp` cannot expose host devices or honor setuid bits.
  - The numeric host user owns the build directory, avoiding root inside the container.
  - The anonymous Emscripten cache permits required LTO asset generation without a host mount.
  - Native bridge sources are read-only; only the temporary build directory is writable.
  - No Docker socket, host credentials, host environment variables, or repository root are passed.
- Build only the surface the bridge needs. For LAME, frontends, decoding, analyzer hooks, GUI integration, and stdio are excluded from the generated module, and a `pkg-config` shim accepts the configure version probe but rejects dependency lookups. For Sonic, only the library and the bridge are compiled: no command-line frontend, no WAV file support, no spectrogram.
- Emit an initialization-only standalone module with no command entry point (for Sonic also no threads and no filesystem), then optimize and strip it to minimize unused runtime surface. Tests separately pin its import list.
- The module is the only repository write, refused unless the result is byte-for-byte reproducible.

### Bridges

- **Fixed buffers whose capacity both sides share.** JavaScript copies PCM in and out through one fixed buffer per stretcher ([Sonic bridge](../../libs/time-stretching/native/sonic-bridge.c)). The capacity in [`mp3-encoding.ts`](../../libs/mp3-encoding/src/mp3-encoding.ts) and [`time-stretching.ts`](../../libs/time-stretching/src/time-stretching.ts) must match the capacity compiled into each bridge. The [LAME bridge](../../libs/mp3-encoding/native/lame-bridge.c) sizes its output by LAME's documented sufficient encoder output space, 1.25 × samples + 7,200 bytes.
- **Untrusted handles.** JavaScript supplies raw numeric handles, so each bridge validates membership before dereferencing one.
- **No adjacent memory.** The LAME bridge never exposes adjacent WASM memory if LAME ever violates its output-size contract, and the time-stretching wrapper never exposes it if the Sonic bridge ever violates its buffer capacity.
- **Reject instead of clamp.** Sonic silently clamps values outside its supported ranges (`SONIC_MIN_*` and `SONIC_MAX_*` in `sonic.h`); the bridge and the TypeScript wrapper reject them instead of stretching wrongly.
- **Sonic quality mode.** The bridge disables Sonic's speed-up heuristics, as the `sonic -q` CLI flag does.
- **Speed factor.** Output duration is the input duration divided by the speed factor.
- **Held-back input.** Sonic's lowest detected pitch is `SONIC_MIN_PITCH` in `sonic.h`, and it holds back two periods of it: two of its longest pitch periods are 738 samples at 24 kHz, so 20 ms of audio comes out only once the stream is padded and flushed. Sonic's flush squeezes the pitch periods it holds back and fades them into silence, which cost about half of a 20 ms tail before the stretcher padded the segment with silence. Sonic removes whole pitch periods, so a stretched tail's content may fall 15% short ([time-stretching tests](../../libs/time-stretching/test/time-stretching.test.ts)).
- **Padding and flush.** Sonic's flush squeezes the pitch periods it still holds back and fades them into silence, cutting up to about 13 ms off a segment's end. The [stretcher](../../libs/time-stretching/src/time-stretching.ts) therefore pads each segment with silence past its end, which turns those periods into ordinary input, and trims the output back to the segment's stretched length. The padding covers two of Sonic's longest pitch periods of output, so it scales with a speed-up. It still flushes, because Sonic holds back the last pitch periods until flushed; without the flush the padding is lost and, with it, the segment's end.
- **Pitch is kept.** The tests check that a 220 Hz tone, which crosses zero 440 times per second, still does after a speed-up, where a resampling speed-up would give 462; they locate content by 1 ms blocks that cross zero at least twice at a tone's amplitude, which a 1,500 Hz tone does and a 220 Hz tone, crossing zero every 2.3 ms, does not.

## Consequences

- Updating LAME, Sonic or the toolchain means updating the pinned input and output checksums together.
- The JavaScript wrappers and the C bridges must change their buffer capacities in the same change.
