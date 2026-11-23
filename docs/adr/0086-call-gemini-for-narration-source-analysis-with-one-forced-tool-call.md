---
status: accepted
---

# Call Gemini for narration source analysis with one forced tool call and no sampling parameters

Narration content selection uses Gemini through AI Gateway ([ADR 0002](0002-use-gemini-for-narration-content-selection.md)); narration language detection joined it in [cup-audio/cup#220](https://github.com/cup-audio/cup/pull/220). Commit `ea072876` stopped sending `temperature` to Gemini. These decisions were recorded from code comments on 2026-11-23.

## Decision

- **One model call shape.** [The completion](../../libs/narration-source-analysis/src/completion.ts) is the model call behind narration source analysis: one forced tool call per request, shared by narration content selection and narration language detection.
- **No sampling parameters.** Gemini rejects sampling parameters on upcoming models, so requests send no `temperature`; the [narration content selection test](../../libs/narration-source-analysis/test/narration-content-selection.test.ts) asserts it.
- **Credentials stay with the gateway.** The [Gemini completion](../../libs/narration-source-analysis/src/gemini-completion.ts) sends the Cloudflare token only as `cf-aig-authorization`; the gateway supplies the stored Google credential, and the Cloudflare token is not forwarded to Google.
- **Usage.** OpenAI-compatible completion tokens already include reasoning tokens.
- **Reasoning effort.** [Production narration language detection](../../libs/narration-source-analysis/src/production-narration-language-detection.ts) uses the reasoning effort narration content selection uses, `low`; `gemini-3.8-flash` rejects `minimal` with HTTP 400.

## Consequences

- Narration source analysis requests carry no sampling parameters, and a test fails if `temperature` comes back.
