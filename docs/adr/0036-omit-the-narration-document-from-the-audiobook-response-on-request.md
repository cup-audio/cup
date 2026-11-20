---
status: accepted
---

# Omit the narration document from the audiobook response on request

Since [cup-audio/cup#495](https://github.com/cup-audio/cup/issues/495) the listener API renders the narration document on every audiobook response ([rendering the narration document](../architecture/conversion.md#rendering-the-narration-document)), and since [cup-audio/cup#496](https://github.com/cup-audio/cup/issues/496) ([ADR 0035](0035-render-the-narration-document-on-request-from-the-stored-narration-source-material-with-versioned-frozen-segmentation.md)) a new conversion's render reads `narration-source-material.html` from R2 and segments it again. The reader polls the audiobook every second while a conversion is pending or synthesizing, and the document never changes once prepared, so each poll would read and render it for nothing. The spec [cup-audio/cup#493](https://github.com/cup-audio/cup/issues/493) left the API shape to [cup-audio/cup#501](https://github.com/cup-audio/cup/issues/501), where it was decided on 2026-11-20, and [cup-audio/cup#502](https://github.com/cup-audio/cup/pull/502) implemented it.

## Decision

`GET /api/audiobooks/{conversionId}` takes an optional query `narrationDocument`, `include` or `omit`, absent meaning `include`. With `omit`, a prepared audiobook's response lacks `narrationDocument`, and the [handler](../../libs/api-server/src/api-server.ts) neither reads nor renders it; every other field stays as it is. The [listener contracts](../../libs/listener-api.routes/src/contracts.ts) describe the route's response with `audiobookResponseSchema`, whose `narrationDocument` is optional, and keep `audiobookSchema`, which requires it, for the audiobook a reader holds.

The [web app's reader query](../../apps/web-app/src/data-fetching/reader.ts) sends `omit` whenever its cache holds a prepared audiobook, and puts the held document into the response. A page load has no cache and a pending audiobook carries no document, so the first prepared response of a page brings it. The player and the reader keep reading the document from the held audiobook, whose type still requires it.

## Considered options

- A separate route for the narration document. Rejected: the audiobook route cannot drop the field without breaking installed apps ([ADR 0010](0010-tolerate-unknown-keys-at-the-listener-api.md): removing a response field still breaks them), so it would serve the document twice, and a page load would need two requests, both checking ownership and loading the manifest.
- Caching the rendered document in the Worker or R2. Rejected: rendering on request exists so that presentation can change at any time without a stored copy going stale.
- A boolean query. Rejected for an enum with an explicit default, which reads unambiguously in the OpenAPI document and can grow values without narrowing ([ADR 0010](0010-tolerate-unknown-keys-at-the-listener-api.md) rule 3).

## Consequences

- Installed apps that never send the query keep getting the document, and a client parses `narrationDocument` as optional only through `audiobookResponseSchema`.
- An unknown `narrationDocument` value is a `400 invalid-input`, as for any listener query value outside its enum.
- Every client that requests the audiobook while holding it must keep the held document itself; a client that sent `omit` without one would lack the document. The web app asserts that a prepared response it completes has one.
- Tests that count audiobook requests by path compare it without the query string, since polls and renewals now carry one.
