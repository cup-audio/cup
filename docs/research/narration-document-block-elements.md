# Block elements in narration document creation

> Historical research, incorporated 2026-11-20. It is the evidence behind [ADR 0035](../adr/0035-render-the-narration-document-on-request-from-the-stored-narration-source-material-with-versioned-frozen-segmentation.md), which describes what this page found as the state before the decision, and behind segmentation version 2. Every finding here describes the code before [#502](https://github.com/cup-audio/cup/pull/502): segmentation version 1 freezes these unit rules for any conversion recorded with it, while version 2 narrates a table row by row and a description list group by group and keeps the line breaks of `pre`, and presentation now keeps tables, description lists and `pre` as structure. [Conversion](../architecture/conversion.md#segmentation-versions) has the current state. [Original](https://github.com/cup-audio/cup/blob/eed01fd1386ca4b944a49acb88b440c438964482/docs/research/narration-document-block-elements.md) on the unmerged branch `research/narration-document-block-elements`.

Researched on 2026-11-18 for [#479](https://github.com/cup-audio/cup/issues/479), part of the map [#472](https://github.com/cup-audio/cup/issues/472). The question is what `createNarrationDocument` produces today, as stored HTML and as synchronization units with their `narrationText`, when the selected HTML contains `table`, `pre`, `hr`, `dl`/`dt`/`dd`, `figure`/`figcaption`, nested lists or blockquotes, and whether narration content selection passes these elements through at all. This page records findings, not decisions.

All code claims refer to commit [`7cf2a405`](https://github.com/cup-audio/cup/tree/7cf2a405) (`origin/main` on 2026-11-18).

## Short answer

- **Only `p`, `h1`–`h6`, `blockquote`, `ul`, `ol`, `li` and the inline `a`, `br`, `code`, `em`, `strong` survive** into the stored HTML. Every other element is either dropped with its content (media, `script`, `svg` and similar), unwrapped into its text (`span`, `i`, `cite` and other inline elements), or turned into an invisible block boundary (`table`, `tr`, `td`, `th`, `caption`, `pre`, `dl`, `dt`, `dd`, `figure`, `figcaption`, `div`, `footer` and every other unknown element).
- **Tables** lose all structure: each cell, and the `caption`, becomes its own synchronization unit rendered as a bare `<p>`, in source order (row by row). This already happens in production-shaped output: two of the seven eval goldens contain selected tables, and in the Cloudflare golden 28 of 115 units are single table cells such as `"380 ms"`.
- **`pre`** loses its line breaks: every newline and run of spaces collapses to one space in both the stored HTML and `narrationText`. The `pre` becomes a `<p>`; a `code` child is kept inline. A `pre` longer than 2,000 characters is split at word boundaries mid-line. The selection prompt excludes "standalone code blocks", and the selection drops code `pre`s in every fixture and probe; a non-code `pre` (a poem) was selected.
- **`hr`** never reaches the narration document: the sanitizer drops it (it has no text), and the AI did not select it in the probe. It only acts as a block boundary.
- **`dl`/`dt`/`dd`** are selected by the AI (probe) and flattened: each `dt` and each `dd` becomes its own `<p>` unit; the term/description pairing is lost in both HTML and audio.
- **`figure`** never reaches narration content selection: source material preparation deletes every `figure` element with its whole subtree, `figcaption` and any `blockquote` inside included. `footer` is deleted the same way. A `figcaption` outside a `figure` would become a plain `<p>` unit.
- **Nested lists and blockquotes** keep their nesting in the stored HTML (`ul`/`ol`/`li`/`blockquote` are kept as wrappers), but every piece of direct text in an `li` or `blockquote` is wrapped in a new `<p>` that carries the unit ID, and each list item or nested item is its own unit.
- **A heading directly before a `blockquote`, `ul`/`ol`, `table` or `dl` is merged into that container's first unit.** For a blockquote or list, the heading is then rendered _inside_ the container: `<blockquote><section id="…"><h2>Voices</h2><p>Quoted.</p></section></blockquote>`, and `<ol><li><section id="…"><h2>Next steps</h2><p>First</p></section></li>…`. The production probe hit this twice.

## How the pipeline treats block elements

Three stages touch the HTML before it is stored:

1. **Source material preparation** ([`prepareLoadedSourcePage`](https://github.com/cup-audio/cup/blob/7cf2a405/libs/prepare-source-material/src/prepare-source-material.ts#L235-L281)) removes every element in [`IRRELEVANT_ELEMENT_TAG_NAMES`](https://github.com/cup-audio/cup/blob/7cf2a405/libs/prepare-source-material/src/prepare-source-material.ts#L44-L55) with its subtree: `button`, `figure`, `footer`, `form`, `input`, `nav`, `noscript`, `script`, `style`, `svg`, plus `role="navigation"`/`role="search"` elements and empty elements. `hr` and `img` are kept as meaningful empty elements.
2. **Narration content selection** ([`runSelection`](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-source-analysis/src/narration-content-selection.ts)) asks Gemini for element IDs and [keeps each selected element's entire subtree](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-source-analysis/src/source-element-selection.ts#L106-L138) plus its ancestors as empty shells; the original source HTML is kept, including `pre` whitespace. The [system prompt](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-source-analysis/src/production-narration-content-selection.ts#L23-L36) mentions none of the elements in question by tag name. It asks to keep "meaningful quotations" and "captions that add context", and to exclude infoboxes, "standalone code blocks, and standalone shell command snippets".
3. **Narration document creation** ([`createNarrationDocument`](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-document-creation/src/narration-document-creation.ts#L117-L335)):
   - [`sanitizeChildren`](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-document-creation/src/narration-document-creation.ts#L414-L458) collapses every text node's whitespace, newlines included, to single spaces ([line 422](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-document-creation/src/narration-document-creation.ts#L422)). It drops [`EXCLUDED_TAG_NAMES`](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-document-creation/src/narration-document-creation.ts#L9-L25) with content, keeps headings, [`STRUCTURAL_TAG_NAMES`](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-document-creation/src/narration-document-creation.ts#L29) (`blockquote`, `li`, `ol`, `p`, `ul`) and [`INLINE_TAG_NAMES`](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-document-creation/src/narration-document-creation.ts#L31) as elements, unwraps [`FLATTENED_INLINE_TAG_NAMES`](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-document-creation/src/narration-document-creation.ts#L33-L59) into their children, and turns every other element into a "boundary" node ([line 444](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-document-creation/src/narration-document-creation.ts#L444)), which keeps the text but emits no tag. A boundary-only element without text, such as `hr`, leaves nothing.
   - [`visitNodes`](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-document-creation/src/narration-document-creation.ts#L216-L285) makes every `p` one narration block, collects other loose text and inline elements into a synthesized `<p>` that is flushed at every boundary, heading or block, and recurses into `blockquote`/`ul`/`ol`/`li` as _wrappers_ that are re-emitted around their units by `serializeRenderedUnits`. Headings are held as pending and joined to the next block, whatever wrapper that block sits in ([lines 158–175](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-document-creation/src/narration-document-creation.ts#L158-L175)).
   - [`createNarrationChunks`](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-document-creation/src/narration-chunking.ts) splits a block over [2,000 characters](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-document-creation/src/narration-chunking.ts#L41) at sentence ends, then at whitespace.

The stored HTML is therefore a flat sequence of `h1`, `p`, `section` (heading + block), `blockquote`, `ul`/`ol`/`li` inside one `article`, with `id` on exactly the element holding each unit.

## Fixture results

Run through `createNarrationDocument` directly with source title `T` (unit `0001`, omitted below). Script and full output in the [archive](narration-document-block-elements.tar.xz) (`r479/fixtures.mjs`, `r479/fixtures-output.txt`).

### Table

Input: `<p>Intro.</p><table><caption>Results by runtime</caption><thead><tr><th>Metric</th><th>Kitesurf</th><th>Chromium</th></tr></thead><tbody><tr><td>CPU: screenshot</td><td>380 ms</td><td>1,173 ms</td></tr><tr><td>Memory</td><td><p>12 MB</p></td><td><ul><li>40 MB</li><li>cold</li></ul></td></tr></tbody></table><p>Outro.</p>`

```html
<p id="narration-unit-0002">Intro.</p>
<p id="narration-unit-0003">Results by runtime</p>
<p id="narration-unit-0004">Metric</p>
<p id="narration-unit-0005">Kitesurf</p>
<p id="narration-unit-0006">Chromium</p>
<p id="narration-unit-0007">CPU: screenshot</p>
<p id="narration-unit-0008">380 ms</p>
<p id="narration-unit-0009">1,173 ms</p>
<p id="narration-unit-0010">Memory</p>
<p id="narration-unit-0011">12 MB</p>
<ul>
  <li><p id="narration-unit-0012">40 MB</p></li>
  <li><p id="narration-unit-0013">cold</p></li>
</ul>
<p id="narration-unit-0014">Outro.</p>
```

Units `0003`–`0013` have `narrationText` equal to the cell text: `"Results by runtime"`, `"Metric"`, `"Kitesurf"`, …, `"40 MB"`, `"cold"`. Each cell becomes one synchronization unit and hence one paid audio segment. A cell with `<br>`-separated lines keeps the breaks as `\n` in `narrationText` and `<br>` in HTML (Anthropic golden, unit `0032`: `"• String match checks …\n• Binary tests …"`).

With a heading directly before the table (`<h2>Results</h2><table><tr><td>A</td><td>B</td></tr></table>`), the heading joins the first cell: `<section id="narration-unit-0002"><h2>Results</h2><p>A</p></section><p id="narration-unit-0003">B</p>`, `narrationText` `"Results\n\nA"`.

### Preformatted text

Input: `<p>Run this:</p><pre><code>npm install⏎npx cup convert --url https://example.com⏎  echo "done"</code></pre><p>Then this poem:</p><pre>Roses are red,⏎   violets are blue.</pre>`

```html
<p id="narration-unit-0002">Run this:</p>
<p id="narration-unit-0003">
  <code>npm install npx cup convert --url https://example.com echo "done"</code>
</p>
<p id="narration-unit-0004">Then this poem:</p>
<p id="narration-unit-0005">Roses are red, violets are blue.</p>
```

`narrationText` of `0003` is `npm install npx cup convert --url https://example.com echo "done"`; of `0005`, `Roses are red, violets are blue.`. A 120-line `pre` (5,500 characters) became three units of up to 2,000 characters, each starting mid-line (`"keeps going line 47 of …"`).

### Horizontal rule

Input: `<p>Before the rule.</p><hr><p>After the rule.</p><p>Text<hr>split</p>`

```html
<p id="narration-unit-0002">Before the rule.</p>
<p id="narration-unit-0003">After the rule.</p>
<p id="narration-unit-0004">Text</p>
<p id="narration-unit-0005">split</p>
```

No trace of the `hr` remains. (The HTML parser already closes a `p` at `<hr>`.)

### Description list

Input: `<dl><dt>Synchronization unit</dt><dd>The smallest navigable portion.</dd><dt>Segment</dt><dt>Track</dt><dd><p>User-facing name.</p><p>Second paragraph.</p></dd></dl>`

```html
<p id="narration-unit-0002">Synchronization unit</p>
<p id="narration-unit-0003">The smallest navigable portion.</p>
<p id="narration-unit-0004">Segment</p>
<p id="narration-unit-0005">Track</p>
<p id="narration-unit-0006">User-facing name.</p>
<p id="narration-unit-0007">Second paragraph.</p>
```

Every `dt` and every paragraph of a `dd` is its own unit; nothing marks which description belongs to which term.

### Figure

Input (as if it reached document creation; in production it does not, see below): `<p>Before.</p><figure><img src="a.png" alt="A chart showing growth"><figcaption>Figure 1: Growth over <em>time</em>.</figcaption></figure><figure><blockquote><p>Ich bin ein Berliner.</p></blockquote><figcaption>— John F. Kennedy</figcaption></figure>`

```html
<p id="narration-unit-0002">Before.</p>
<p id="narration-unit-0003">Figure 1: Growth over <em>time</em>.</p>
<blockquote><p id="narration-unit-0004">Ich bin ein Berliner.</p></blockquote>
<p id="narration-unit-0005">— John F. Kennedy</p>
```

The `img` and its `alt` are dropped; the caption becomes a plain `<p>` unit.

### Nested lists

Input: `<ul><li>Top one<ul><li>Nested a</li><li>Nested b<ol><li>Deep i</li></ol></li></ul></li><li><p>Top two para</p><p>Second para in item</p></li><li>Top three with <strong>bold</strong> and <a href="/x">link</a></li></ul>`

```html
<ul>
  <li>
    <p id="narration-unit-0002">Top one</p>
    <ul>
      <li><p id="narration-unit-0003">Nested a</p></li>
      <li>
        <p id="narration-unit-0004">Nested b</p>
        <ol>
          <li><p id="narration-unit-0005">Deep i</p></li>
        </ol>
      </li>
    </ul>
  </li>
  <li>
    <p id="narration-unit-0006">Top two para</p>
    <p id="narration-unit-0007">Second para in item</p>
  </li>
  <li>
    <p id="narration-unit-0008">Top three with <strong>bold</strong> and <a href="/x">link</a></p>
  </li>
</ul>
```

(Whitespace added for reading; the stored HTML has none.) Nesting survives; each item's direct text gets a synthesized `<p>` carrying the unit ID, and each item is a unit. `narrationText` carries no list markers or numbering: `"Top one"`, `"Nested a"`, `"Deep i"`.

### Blockquotes

Input: `<blockquote>Bare quote text<cite>Someone</cite></blockquote><blockquote><p>Quoted para.</p><blockquote><p>Nested quote.</p></blockquote><ul><li>List in quote</li></ul><footer>— Author</footer></blockquote>`

```html
<blockquote><p id="narration-unit-0002">Bare quote textSomeone</p></blockquote>
<blockquote>
  <p id="narration-unit-0003">Quoted para.</p>
  <blockquote><p id="narration-unit-0004">Nested quote.</p></blockquote>
  <ul>
    <li><p id="narration-unit-0005">List in quote</p></li>
  </ul>
  <p id="narration-unit-0006">— Author</p>
</blockquote>
```

Nesting survives. `cite` is unwrapped into the surrounding text without a separator (the input had none, so a browser renders the same run-on). The `footer` became a `<p>` here only because the fixture bypassed source material preparation, which deletes `footer` elements.

### Heading before a container

| Input                                                                 | Stored HTML                                                                                                                                    | `narrationText`         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `<h2>Voices</h2><blockquote><p>Quoted.</p></blockquote><p>After.</p>` | `<blockquote><section id="narration-unit-0002"><h2>Voices</h2><p>Quoted.</p></section></blockquote><p id="narration-unit-0003">After.</p>`     | `"Voices\n\nQuoted."`   |
| `<h2>Next steps</h2><ol><li>First</li><li>Second</li></ol>`           | `<ol><li><section id="narration-unit-0002"><h2>Next steps</h2><p>First</p></section></li><li><p id="narration-unit-0003">Second</p></li></ol>` | `"Next steps\n\nFirst"` |

The heading is placed inside the quote or list item in the stored HTML, because the unit is emitted under the wrappers of the block it was joined to.

## What narration content selection passes through

### Eval fixtures

The seven committed eval cases (`libs/narration-source-analysis/test/evals/cases`, scan script `r479/scan-evals.mjs` in the archive) are the production candidate's accepted outputs, so they show what selection kept on real pages:

| Element                      | Cases where it occurs in `input.html`                                      | Kept in the golden                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `table`                      | Anthropic (4), Cloudflare (1), English Wikipedia (1), French Wikipedia (1) | Anthropic 4 of 4 and Cloudflare 1 of 1 (content tables, one unit per cell). Not the Wikipedia ones: a "more citations needed" maintenance box and the infobox. |
| `pre`                        | Anthropic (2), Cloudflare (2)                                              | None (all are code listings)                                                                                                                                   |
| `hr`                         | French Wikipedia (3, infobox styling)                                      | Not visible in goldens; `hr` produces no unit either way                                                                                                       |
| `blockquote`                 | English Wikipedia (7)                                                      | 7 of 7                                                                                                                                                         |
| nested lists                 | derStandard (1, site navigation)                                           | No                                                                                                                                                             |
| `dl`, `figure`, `figcaption` | none                                                                       | –                                                                                                                                                              |

Cell units are a large share of the table-bearing goldens: in Cloudflare, all 28 cells of its one table are kept as 28 of 115 units (`"Metric"`, `"Kitesurf"`, `"380 ms"`, `"1,173 ms"`, …); the Anthropic golden's tables yield units such as `"Methods"`, `"Strengths"`, `"Weaknesses"` three times over, one per table.

No fixture contains a `figure`, consistent with source material preparation deleting them.

### Paid probe

Because no fixture contains `dl`, a prose nested list or a non-code `pre`, one synthetic article ([`r479/probe-input.html`](narration-document-block-elements.tar.xz)) with each element in question plus a `footer` was run through `cleanAudiobookSourceMaterialHtml` (the cleanup step of preparation), the production selector (`PRODUCTION_CONFIG`, `gemini-3.8-flash`, low reasoning effort) and `createNarrationDocument`, three times. All three runs selected exactly the same HTML (outputs `r479/probe-run-{1,2,3}.json`):

- **Kept:** the nested `ul` and nested `ol`, the whole `table` including `caption`, the `dl` with all `dt`/`dd`, the outer and nested `blockquote` including its attribution paragraph, and the poem `pre`.
- **Dropped:** the code `pre` (`python modal_split.py …`) and the `hr`. The `footer` never reached selection.
- The resulting 38 units include 13 table units (`"Share of trips by mode, 2024"`, `"District"`, `"Walking"`, …, `"38%"`), four `dl` units, and two headings merged into containers: `"What residents said\n\nWe stopped driving …"` rendered inside the `blockquote`, and `"What comes next\n\nExtend the superblock pilot …"` rendered inside the first `li` of the `ol`.

**Spend:** 3 selection requests, estimated $0.0018 each, **$0.0055 total** (estimate from the library's own `estimatedCostUsd`, Gemini 3.8 Flash list prices in [`gemini-completion.ts`](https://github.com/cup-audio/cup/blob/7cf2a405/libs/narration-source-analysis/src/gemini-completion.ts#L90)). No speech synthesis was run, and no real page was converted; the fixtures plus this probe answered the selection question.

## Limits

- The probe is one synthetic English article; selection on real pages may differ, for example for tables that look like layout or for `pre` that holds prose. Only three runs, with identical results.
- `figure` handling was established from the preparation code, not observed on a live page.
- Not checked: how the web app styles the resulting HTML, `colspan`/`rowspan` tables, `details`/`summary`, and right-to-left content. The pre-existing `lang`/`dir` attributes are kept on structural elements but were not exercised.
- Existing conversions store only the resulting HTML and units, so the lost table, `dl`, `pre` and `figure` structure cannot be recovered from `audiobook.json` (map #472, Out of scope).

## Reproduction

The [archive](narration-document-block-elements.tar.xz) holds `fixtures.mjs` (direct `createNarrationDocument` runs; run with Node 24 from `libs/narration-document-creation`), `scan-evals.mjs` (eval fixture scan), `probe.ts` (paid selection probe; run with `node --env-file=.env.evals probe.ts <dir> 3` from `libs/narration-source-analysis`), the probe input, its cleaned form, and all outputs. The scripts import the libraries by absolute path of the checkout they ran in; adjust the paths to rerun.
