---
status: accepted
---

# Measure design fidelity by bands of ink with a rasterization tolerance

The [fidelity check](../../qa/fidelity-check/src/fidelity-check.ts) compares a rendered screen with the design's image, introduced in [#175](https://github.com/cup-audio/cup/pull/175). A design tool and a browser never rasterize identically, so a pixel-exact comparison would always fail. These decisions were recorded from code comments on 2026-11-23.

## Decision

- The page renders at a viewport where one CSS pixel equals one design pixel. It should render at a device scale above 1, because 1x text snaps to whole pixels, unlike the design's render; the screenshot is scaled down to the image's size to compare like with like.
- Both images are reduced to bands: the screen's rows of ink, separated from the next ones by an empty row, in design pixels. The two images' bands are compared with each other.
- A design tool and a browser rasterize an edge up to 1 pixel apart, so a band edge that close is no mismatch.
- A pixel is ink when its colour distance (summed over the colour channels) from the background exceeds a limit; the limit for ink is lower than the one for a noticeable difference, and the higher limit leaves out the antialiased edges of text. The background is the colour of the design's corner, and the rendered page is measured against the same colour.
- The mismatch share, the share of compared pixels that differ noticeably, never reaches zero, because text edges keep it above zero.
- Rows such as a device status bar drawn into the design can be skipped. A design with no ink below the skipped rows fails the check, since comparing no rows at all would report a match.
- The page's elements and loaded fonts are measured after the screenshot, which waits for the fonts that the page has started loading. In the check's own tests the font is added after `setContent`, which would otherwise wait for the font through the load event.

## Consequences

- The check reports where rows of ink differ rather than pixel noise.
- A design with a non-uniform corner colour skews the ink detection.
