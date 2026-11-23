---
status: accepted
---

# Load source pages and cover images through the browser, and trust only what they prove

[CUP-103](https://linear.app/cup-audio/issue/CUP-103/give-tracks-a-title-when-the-article-has-no-title-heading) refines the visible headline (2026-11-23): the browser marks every `<h1>` that renders visibly, and source preparation skips [site headings](../GLOSSARY.md#site-heading), such as a blog's masthead, before taking the first as the visible headline. Without one, the source title comes from the page metadata title before the document title, with the site name removed ([source preparation](../architecture/conversion.md)).

Source preparation loads publisher pages that Cup does not control, in a static and a rendered load, and reads their metadata, their source subtitle and their declared cover image. Cover images arrived in [cup-audio/cup#5](https://github.com/cup-audio/cup/pull/5), source subtitle detection in [cup-audio/cup#130](https://github.com/cup-audio/cup/pull/130) ([ADR 0014](0014-cut-source-material-at-the-visible-headline-and-carry-the-source-subtitle-in-the-narration-document.md)), screen-reader-only content handling in [cup-audio/cup#506](https://github.com/cup-audio/cup/pull/506), and source-page cookies in commit `0e40961b`. These decisions were recorded from code comments on 2026-11-23.

## Decision

### Source pages

- **Two loads, one kept.** [Source preparation](../../libs/prepare-source-material/src/prepare-source-material.ts) keeps the static load when it is equivalent: the rendered load must have more than `BETTER_SOURCE_MATERIAL_TEXT_FACTOR` (1.1) times its text, because rendering often adds small dynamic counters and page chrome. Each load detects its own source subtitle, so the subtitle always belongs to the selected HTML, and the declared language comes from the load whose source material is kept.
- **The cover image comes from the rendered load,** independent of which load has more text: `SOURCE_PAGE_JAVASCRIPT_MODES` puts the rendered load last, and its metadata is the fuller declaration because a static shell often carries none or only a site-wide image.
- **Markers set by the loader.** The loader marks the visible headline and screen-reader-only content in the source page with attributes; `prepareLoadedSourcePage` reads the headline marker and drops the marked screen-reader-only content.
- **Marking in the page.** The loader marks the first `<h1>` that renders visibly, so the source title never comes from a hidden heading such as a consent wall's; visually hidden headings, such as `.sr-only`, keep a one-pixel box, so a visible headline must be larger. It marks as screen-reader-only each outermost rendered element that holds text but is visually hidden: a box of at most one pixel that clips its content (the `.sr-only` pattern; a zero-size wrapper of an absolutely positioned label shows its content, while `.sr-only` variants all clip it through `overflow`, `clip` or `clip-path`), or one placed wholly beyond the page's left or top edge (the older `left: -9999px` pattern). An element with `display: contents` has no box of its own, so only its children are measured. Content hidden from everyone, such as a collapsed section or `display: none`, is not marked, because it can be source content. The browser serializes both marking functions into the source page, so they must stay self-contained. Screen-reader-only content is removed before the source title is read, so hidden text inside the visible headline stays out of it.
- **Descriptions read from head and body.** The loaded `bodyHtml` lacks the head, and cleanup in `prepareLoadedSourcePage` drops body scripts, so metadata descriptions are read from the head and body before cleanup.
- **Cover image declarations.** Only the publisher-declared cover image in page metadata is read; body images are never considered. Each candidate keeps the alternative text declared for it, and an unusable declaration, such as an embedded image, falls through to the next candidate. Open Graph attaches structured properties such as `og:image:secure_url` and `og:image:alt` to the `og:image` they accompany; a page can declare several images, and only the first one's properties are returned, so a later image's properties never describe the first.
- **Bounded declarations.** A cover image declaration travels in a workflow step result, so its size must stay bounded. Open Graph image properties are read in order of preference; the secure variant names the same image as `og:image`.
- **Metadata.** Open Graph uses `property`; Twitter cards and many publishers use `name` for either ([HTML tree helpers](../../libs/prepare-source-material/src/html-tree.ts)).
- **`<template>` content.** parse5 keeps a `<template>`'s content in a separate document fragment, apart from its child nodes. Every walk in source preparation goes through one child-element helper, so all of them treat `<template>` content alike; [source element selection](../../libs/narration-source-analysis/src/source-element-selection.ts) reads template content the same way.
- **Cookies.** Source-page cookie configuration is validated without exposing cookie values in errors ([source-page cookies](../../libs/create-audiobook-from-url-workflow/src/source-page-cookies.ts)).

### Source subtitle

[Source subtitle detection](../../libs/prepare-source-material/src/source-subtitle.ts) follows [ADR 0014](0014-cut-source-material-at-the-visible-headline-and-carry-the-source-subtitle-in-the-narration-document.md), with these rules:

- Each `class`, `itemprop` or `data-*` word that marks a source subtitle candidate or its wrapper is proven by a recorded source page; a word is added only with a fixture that needs it.
- A block whose words are all month and weekday names and their abbreviations in English and German, clock words, or English ordinal suffixes, beside digits, is a date. A block holding nothing but `<time>` elements and separators is a date too, but a standfirst can mention a date in an inline `<time>` and stays a candidate.
- Declared descriptions come from the `description` of each top-level and `@graph` JSON-LD entity; nested entities describe others. Publisher markup is untrusted, so malformed JSON-LD declares nothing.

### Cover images

[Cover image loading](../../libs/prepare-source-material/src/load-cover-image.ts):

- **As a browser navigation.** The declared cover image is requested through the browser, so the request carries the browser's network identity, the source page as referrer, and the cookies configured for the image's host. A navigation asks for a document by default, so the loader sends an image `Accept` header for publishers that negotiate.
- **Refused by declared length before buffering.** The navigation resolves at commit, which leaves the body unread, so an oversized image is refused by its declared length before the browser has buffered it. The declared length is optional and unverified, so the read body is checked again.
- **Redirects.** Request interception does not see redirect hops, so they are checked once the chain is known.
- **Format from the bytes.** An accepted raster format is identified from the file's leading bytes; the response header is not trusted. SVG is deliberately left out because it can carry scripts. Animation is not a reason to refuse an image: the original is kept, and a surface decides how to show it.
- **Refusal versus failure.** A refusal is why a cover image that could be requested is deliberately not kept, and retrying cannot change it, so it is an expected outcome; transport failures and timeouts throw instead.

## Consequences

- Only what a page's bytes and recorded fixtures prove is trusted; a new subtitle marker word needs a recorded source page.
- A cover image costs a browser navigation of its own.
