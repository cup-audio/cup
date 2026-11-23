---
status: accepted
---

# Present the narration document in step with segmentation

[ADR 0035](0035-render-the-narration-document-on-request-from-the-stored-narration-source-material-with-versioned-frozen-segmentation.md) splits rendering into frozen, versioned segmentation and presentation that may change at any time, and renders on every request that carries the narration document. Presentation must still mark exactly the text segmentation assigned to each unit, so the reader can highlight it, and must survive how a browser parses the HTML. It was implemented in [cup-audio/cup#502](https://github.com/cup-audio/cup/pull/502), for [cup-audio/cup#496](https://github.com/cup-audio/cup/issues/496); the presentation rules are described in [rendering the narration document](../architecture/conversion.md#rendering-the-narration-document). These decisions were recorded from code comments on 2026-11-23.

## Decision

### Segmentation versions

- **Each version keeps its own copy.** [Segmentation version 1](../../libs/narration-document-creation/src/segmentation-version-1/segmentation-version-1.ts) keeps its own copy of the element classification instead of sharing presentation's, which may change at any time. [Version 2](../../libs/narration-document-creation/src/segmentation-version-2/segmentation-version-2.ts) starts as a copy of version 1 and reuses version 1's frozen [unit text segmentation](../../libs/narration-document-creation/src/segmentation-version-1/unit-text-segmentation.ts), so the rules it keeps from version 1 stay those of version 1; it shares nothing with presentation. Since version 2 splits its new kinds of units with version 1's `splitText` too, that splitter is as frozen as the rest of version 1.
- **Rules worth knowing.**
  - Unknown and custom block containers remain boundaries while their visible text is retained.
  - The source subtitle unit is added before any body block, so it never absorbs a pending heading.
  - In version 2, a table row too long for one unit, together with a heading it joins, falls back to version 1's rules, one unit per cell, and a `div` that wraps a description list group ends the groups around it.
- **Golden fixtures.** Version 1's expected units were generated from `createNarrationDocument` before segmentation was split out of it. Version 2's were written from the spec's version 2 rules, and the fixtures of the rules version 2 keeps from version 1 are copies of version 1's. Both are frozen: a change that alters them must become a new segmentation version. The existing-conversion fixtures' stored HTML and units were produced by `createNarrationDocument` as it was when each historical shape was written, so the existing-conversion path keeps rendering every audiobook prepared before the narration document was rendered on request. The narration content selection evals segment with the version preparation uses, so the goldens hold the units production produces. In that eval, scores never gate: the file snapshot gates the production candidate, so `eval:update` can rewrite a golden that differs instead of failing before it.

### Presentation

[Presentation](../../libs/narration-document-creation/src/presentation.ts) and its shared [presentation rules](../../libs/narration-document-creation/src/presentation-rules.ts):

- **Dropped elements.** Some elements are dropped with everything inside them. `figure` is not among them, because images and their captions are to be shown later (Linear CUP-82).
- **Structural containers** are kept as themselves around the units inside them, and dropped when no unit is inside.
- **Table parts survive the browser.** Table parts are kept as themselves inside a table that holds a unit, even when empty, so that its rows and columns stay aligned. Outside a table they are replaced by what they hold, because a browser would drop them, and with them the unit attribute the reader looks for. Table cells and captions carry the unit attribute themselves only inside a table.
- **Elements carry the unit attribute** when one unit holds all their text. Under segmentation version 2, a table row that is one unit is a narration block of its own and keeps its cells, each flattened as one item, while the row carries the unit; so is each term and description of a description list group. A table cell, term or description that segmentation reads as one item has the blocks inside it flattened into its text, separated by a space, as segmentation narrates them; inside a table cell, term or description, any block is flattened with a space on either side.
- **Text ranges count like segmentation.** The separator between the blocks of one unit is the one segmentation's text ranges count. Browser-visible whitespace is kept aligned with the units' narration text normalization. Preformatted text keeps its line breaks, which normalization turns into `br` elements, and the indentation after them; every other whitespace run still becomes one character. A line's leading whitespace in preformatted text shows its indentation but is no part of the narration text, so it counts as no text when units divide a block, goes with the line it starts, and shows only at the start of a line; anywhere else it is whitespace like any other.
- **Scrolling cards.** A `table` or `pre` is wrapped in the element the reader styles as a scrolling card, so a wide block never widens the page; the wrapper carries no unit attribute.
- **Segmentation mirrors the shown whitespace.** Both segmentation versions mirror the whitespace that the narration document shows, which unit texts are read from.
- **Text outside narration blocks holds no narration text,** such as a heading equal to the source title, which the source title unit replaces.
- **Split trailing headings.** Segmentation records no text ranges for split trailing headings, so presentation finds them again.
- **Links.** A link without text is dropped, and replacing it with its whitespace keeps the text's length. A footnote or other jump within the page, or a link to the page itself, is shown as plain text ([links](../../libs/narration-document-creation/src/links.ts)): it would leave Cup only to land on the publisher's copy of the text the listener is already reading.

### Existing conversions

[Existing-conversion presentation](../../libs/narration-document-creation/src/existing-conversion-presentation.ts):

- Narration document creation drew a heading inside a container when the heading came right before the container in the narration source material; presentation moves such headings before the container.
- A `section` only grouped the elements of one unit; each of them now carries the unit itself.
- A unit is registered even when its elements hold no text, so the check sees it.
- Stored HTML only ever held `em`, `strong` and `code` of the kept inline elements. It follows the same rules as a new conversion's markup, which flatten any other element to its text.

### CPU budget

The [CPU budget tests](../../libs/narration-document-creation/test/new-conversion-rendering/cpu-budget.test.ts) set the CPU time one render may take stricter than the Worker's configured limit (`limits.cpu_ms` in the Worker's Wrangler config) on purpose: the listener API renders on every request that carries the narration document, so rendering must stay small next to the request's other work, not just finish before the Worker is stopped. They measure the fastest of several renders, so a busy test machine doesn't fail the budget.

## Consequences

- A presentation change must keep each unit's marked text equal to its narration text, or the render-time check falls back.
- Images and captions inside `figure` stay in the narration document until CUP-82 shows them.
