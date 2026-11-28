---
status: accepted
---

# Shape the web app's screens around browser, accessibility and design constraints

> Note, 2026-11-24: the avatar's name now also comes from Apple. On iOS, Supabase cannot fill it from the native sheet's identity token, so the iOS adapter writes the name the sheet returned into the same Supabase `user_metadata` fields with `updateUser`; Cup still stores no name of its own ([account holder's name](../architecture/web-app.md#account-holders-name), [#519](https://github.com/cup-audio/cup/issues/519)).

The redesigned screens (Recents, the detail view, the account chrome and the conversion screens) follow Figma designs on Base UI components, and many of their details exist because of a browser behaviour, an accessibility need or a rule of the design rather than taste. Most of them came with the Recents redesign in [cup-audio/cup#101](https://github.com/cup-audio/cup/pull/101) and the conversion screens in [cup-audio/cup#174](https://github.com/cup-audio/cup/pull/174); others with [cup-audio/cup#138](https://github.com/cup-audio/cup/pull/138) (deleting a conversion, with the status announcer and the deletion dialog), [cup-audio/cup#168](https://github.com/cup-audio/cup/pull/168) (cover images that never flash), [cup-audio/cup#177](https://github.com/cup-audio/cup/pull/177) (a page title per screen), [cup-audio/cup#292](https://github.com/cup-audio/cup/pull/292) (content out from under the iOS status bar) and [cup-audio/cup#502](https://github.com/cup-audio/cup/pull/502) (the narration document's interactions); the visually-hidden recipe dates from the 1.0.0 release. These decisions were recorded from code comments on 2026-11-23.

## Decision

### Accessibility

- **A live region that exists before any message.** The shell renders its one polite live region for outcomes that have no place on screen, such as a deletion that left the page it started on ([status announcer](../../apps/web-app/src/app/status-announcer.tsx)). The region exists before any message, because screen readers often skip a region inserted together with its text.
- **The screen mounted last names the page.** React hoists a screen's `<title>` into the document head, in front of every title already there, so a dialog over Recents takes over the title while it is open and Recents' title returns when it closes; without one, such as on the start page, the static title in `index.html` applies ([page title](../../apps/web-app/src/app/components/page-title.tsx)).
- **The deletion dialog opens once the menu has returned focus to its trigger**, so the dialog can move focus to its Cancel and later return it to the trigger ([detail top bar](../../apps/web-app/src/app/components/detail-top-bar.tsx)).
- **The avatar's initials are decoration**; the link says where it goes ([account avatar](../../apps/web-app/src/app/components/account-avatar.tsx)).
- **"Play from here" is drawn, not written into the page**, so copied text and text matches leave it out ([narration document interaction](../../apps/web-app/src/app/components/narration-document-interaction.ts)). A click on a link without a pointer position (`detail` 0) comes from the keyboard and opens the link popover for the keyboard; the click that ends a text selection is not a request to play. A segment's "Play from here" button never goes inside a heading, where it would become part of the heading's name; since an `<hgroup>` holds only headings and paragraphs, a heading's button goes before it, or before its `<hgroup>`, and since a table row holds only cells, a row's button goes into its first cell.
- **The link popover holds a real link**, so it opens the way the top bar's "Open original page" does: a new tab, or the system browser in the shells. A transparent backdrop under it takes every other tap, so closing it plays nothing. A link removed from the page during its click no longer navigates, so the popover closes only afterwards. The popover is appended to the body, outside the redesigned screen, so it opts out of Space Mono itself.
- **The scrubber draws the focus ring** around itself, because its thumb is invisible ([player sheet](../../apps/web-app/src/app/components/player-sheet.tsx)).
- **Icon buttons keep a hit area of at least 44 px** with no border or padding ([icon button](../../apps/web-app/src/app/design-system/icon-button.tsx)).
- **Visually hidden content** follows [Josh Comeau's hidden-content recipe](https://courses.joshwcomeau.com/css-for-js/02-rendering-logic-2/18-hidden-content) ([utils](../../apps/web-app/src/app/utils.ts)).

### Browser behaviour

- **A cover never flashes its placeholder.** When the URL changes, the [cover image](../../apps/web-app/src/app/design-system/cover-image.tsx) keeps showing the previous image until the new one has loaded, and an image the document has already loaded shows on the first paint, because the list of available images completes a cached image as soon as its `src` is set.
- **The status bar gets a backdrop.** The page reaches under the status bar (`viewport-fit=cover` in `index.html`), so a strip as tall as the top safe area paints the page's background behind it and scrolled content does not show through; it takes no room where there is no safe area, such as on a desktop ([status bar backdrop](../../apps/web-app/src/app/components/status-bar-backdrop.tsx)).
- **Scroll reach observes the scroll container.** An `IntersectionObserver`'s root margin extends only its root, so the infinite-scroll sentinel observes its nearest vertically scrolling ancestor rather than the viewport, whose margin would not keep the ancestor from clipping it ([scroll reach](../../apps/web-app/src/app/use-is-in-scroll-reach.ts)).
- **Recents is masonry on 1 px grid rows.** Each item spans as many rows as its measured height plus the grid's column gap, which also serves as the gap between items in a column; auto-placement puts every item into the column that ends highest, so the DOM order (and with it focus and reading order) runs left to right, top down, and appended items never move earlier ones. The list carries `data-masonry` while the hook is active, and its styles switch to 1 px rows only then. Items must not stretch to their grid area (`align-self: start`), or the observer would measure the spanned area ([masonry row spans](../../apps/web-app/src/app/use-masonry-row-spans.ts), [Recents card](../../apps/web-app/src/app/components/recents-card.tsx)). Row spans are set before the 1 px rows apply, so a list rendered with its items, such as Recents shown again from the cache, has its full height when the router restores the scroll position after the render; an observer would only measure the items a frame later. The [masonry research](../research/recents-masonry-layout.md) explains why not `display: grid-lanes` or multi-column.
- **`scrollbar-width` is not inherited**, so it is set on every element; the thin variant is the one that draws no arrow buttons ([global styles](../../apps/web-app/src/app/global-styles.ts)).
- **Stylesheet order decides a composed class's color.** The destructive menu item's styles are defined after the menu item's, so its color comes later in the stylesheet and wins.

### Design rules

- **The redesign is scoped.** Pages that are not redesigned keep Space Mono, which a global rule sets on `span` and `input`; redesigned screens opt out with `interTypefaceScope` (`data-typeface="inter"`) and render in Inter only. Every [text style](../../apps/web-app/src/app/design-system/text-styles.ts) sets its own font family, so it also applies to elements the global Space Mono rule reaches.
- **One ink color.** The redesigned screens use one ink color at several strengths and no other text color.
- **Undrawn interaction states.** The design draws no pressed or hover state, so the redesigned controls use an 8 % ink overlay in the element's own shape, on hover only for pointers that can hover; every interactive element shows the same global focus ring ([interaction states](../../apps/web-app/src/app/design-system/interaction-states.ts)).
- **Icons come from Figma.** The icons are exported from Figma as SVG (kept in `docs/research/recents-design-tokens/icons`) for the [conversion screens](https://www.figma.com/design/Mud3jhH7Lliuv0jIbCS63R/cup?node-id=403-11619) and the [Add a Track sheet](https://www.figma.com/design/Mud3jhH7Lliuv0jIbCS63R/cup?node-id=485-12270). They paint in `currentColor` and are decorative: the control or text beside one carries the accessible name. The export's full-size clip paths are left out because they clip nothing. Play is drawn only disabled (`play-disabled.svg`); the app draws it at full ink and lets a disabled control dim it ([icons](../../apps/web-app/src/app/design-system/icons.tsx)).

- **A local `css` tag for global styles** exists only so the VS Code extension `styled-components.vscode-styled-components` highlights the CSS syntax ([global styles](../../apps/web-app/src/app/global-styles.ts)).

### Data shown as given

- **The avatar uses the name Supabase supplies.** Cup stores no name: Supabase fills `name` (and the deprecated `full_name`) from the identity provider ([research](../research/avatar-initials-name-source.md)). The initials are the first letter grapheme (graphemes keep a decomposed accent or a surrogate pair together, where `word[0]` would split it) of the first and of the last word, skipping words without a letter; the name is shown as written, so family-name-first names keep their order, and the avatar lowercases with CSS. A name without a letter shows the person glyph ([avatar initials](../../apps/web-app/src/app/avatar-initials.ts)).
- **A malformed source URL shows as given.** The source host drops a leading `www.`; a URL that does not parse shows as given, so a malformed stored URL stays recognizable ([source host](../../apps/web-app/src/app/source-host.ts)).
- **An unknown preparation phase reads "Preparing".** The listener client parses a phase it does not know as absent, so a missing and an unknown phase both read "Preparing" ([preparation phase label](../../apps/web-app/src/app/preparation-phase-label.ts)).

## Consequences

- New redesigned screens must opt into `interTypefaceScope`, use the ink strengths and the shared interaction states, and keep icon buttons at 44 px.
- The masonry needs its items measured; a card whose height changes re-places the cards after it.
