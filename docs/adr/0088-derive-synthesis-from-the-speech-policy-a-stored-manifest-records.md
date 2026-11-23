---
status: accepted
---

# Derive synthesis from the speech configuration a stored manifest records

A conversion keeps synthesizing segments long after it was prepared, through retries and resumed runs, and the speech policy changed several times: the narration language arrived with policy 5 ([cup-audio/cup#220](https://github.com/cup-audio/cup/pull/220)), the Sonic time-stretch with policy 6 ([cup-audio/cup#281](https://github.com/cup-audio/cup/pull/281), [ADR 0023](0023-time-stretch-narration-audio-after-synthesis-with-sonic.md)), and overlap and cut came and went as policy 7 ([cup-audio/cup#352](https://github.com/cup-audio/cup/pull/352), Linear CUP-58, [ADR 0028](0028-withdraw-overlap-and-cut.md)). ElevenLabs Eleven v3 was added as a second provider in commit `17c579ea`. These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Resumed conversions keep what they started with.** They retain the model, speech policy and narration pace recorded in their manifest ([speech synthesis configuration](../../libs/audiobook-production/src/speech-synthesis-config.ts)):
  - Policy 3 sends no narration language and wraps the text in a transcript instruction.
  - Policy 4 sends no narration language.
  - Policy 5 sends the narration language, when the model can speak it, and stores the provider audio unstretched.
  - Policy 6 sends the same request as policy 5 and time-stretches the provider audio to its narration pace, `POLICY_6_SPEED_FACTOR`, before encoding.
  - Policy 7 was overlap and cut, deployed on 2026-11-13 and withdrawn the same day ([ADR 0028](0028-withdraw-overlap-and-cut.md)). Its audiobooks keep loading, and a resumed policy 7 conversion synthesizes its remaining segments as policy 6 does, without overlap, which is what policy 7 fell back to whenever a cut check failed.
- **Legacy Gemini 3.1 input.** Gemini 3.8 reads input verbatim, so the transcript-instruction classifier workaround is kept only for the legacy 3.1 configuration (<https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-lite-tts#migration-guide>).
- **Stored identity, not the current default.** A stored segment's synthesis identity is read independently of the current production default ([audio segment storage](../../libs/audiobook-production/src/audio-segment-storage.ts)).
- **Manifests from before `speechConfig` was recorded** keep the requests they were prepared with ([store audiobook](../../libs/audiobook-production/src/store-audiobook.ts)).
- **Speech configurations are equal by every field,** the comparison audio segment reuse makes.
- **The narration pace is keyed by policy.** `getSpeedFactor` follows from the provider and policy version rather than a configuration field, so a stored manifest or segment needs no further metadata to tell its narration pace: Gemini policies 6 and 7 speed up by `POLICY_6_SPEED_FACTOR`, every other policy keeps the provider audio unstretched. It is keyed by the policy rather than by `GEMINI_SPEECH_CONFIG`, so policy 6 manifests keep their pace after a later policy becomes the deployment configuration. For the same reason the [speech configuration test](../../libs/audiobook-production/test/speech-synthesis-config.test.ts) spells policy 6 out rather than taking it from `GEMINI_SPEECH_CONFIG`.
- **The provider is switched in code.** `SPEECH_CONFIG` is assigned from `GEMINI_SPEECH_CONFIG`; changing this assignment and redeploying switches the backend provider. The ElevenLabs configuration uses the voice Lawrence, "Bright and Informative" (`ktkP7Nsj67dw2zcplQYt`).
- **ElevenLabs PCM.** The ElevenLabs PCM endpoint answers with `audio/pcm` or `application/octet-stream`, not an MP3 container ([ElevenLabs synthesis](../../libs/audiobook-production/src/synthesize-elevenlabs-audio.ts)).
- **Policy 7's unit field stays a type detail.** The [narration content selection eval harness](../../libs/narration-source-analysis/test/evals/narration-content-selection-harness.ts) picks only the fields narration document creation writes: the optional `continuesNarrationBlock`, kept for reading speech policy 7 manifests, is no JSON value under `exactOptionalPropertyTypes`.

## Consequences

- Every speech configuration a stored manifest or segment may record stays in the code for as long as such manifests exist.
- A new speech policy that changes the pace must extend `getSpeedFactor` by policy, never by the current deployment configuration.
