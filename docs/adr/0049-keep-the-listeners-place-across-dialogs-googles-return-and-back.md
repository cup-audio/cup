---
status: accepted
---

# Keep the listener's place across dialogs, Google's return and Back

Several screens open over Recents, and some steps leave the app for Google and come back to whatever URL the browser shows. Back has to return the listener to where they were, including Recents' scroll position, and a step that leaves for Google must find its dialog again. [cup-audio/cup#116](https://github.com/cup-audio/cup/pull/116) moved the account settings into a dialog and added the account recovery page, [cup-audio/cup#101](https://github.com/cup-audio/cup/pull/101) redesigned Recents, the detail view and the home redirect, and [cup-audio/cup#165](https://github.com/cup-audio/cup/pull/165) set Back's behaviour and the dialog's initial focus. These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Account dialog URL.** The [account dialog](../../apps/web-app/src/routes/_shell.recent.account.tsx) over Recents has no route mask hiding its URL, unlike the [Add dialog](../../apps/web-app/src/routes/_shell.recent.add.tsx), whose route mask in `createAppRouter` keeps the URL bar on `/recent`. Confirming a deletion or recovery signs in with Google again, and that sign-in returns to the URL bar's path, where the dialog has to open again to show the confirmation step.
- **Stay while a step runs.** While a deletion or recovery step runs, the dialog cannot be left, because leaving would lose the return from Google, which comes back to the dialog's URL ([account confirmation](../../apps/web-app/src/data-fetching/account-confirmation.ts)).
- **Initial focus.** Close takes the account dialog's initial focus: the first tabbable button can be a step such as "Schedule deletion", which one Enter would run.
- **Account recovery page.** [Account recovery](../../apps/web-app/src/routes/account-recovery.tsx) restores an account whose deletion is scheduled, and the scheduled-deletion email links to it. Scheduling deletion signs the listener out, so the page signs them in itself, outside Recents and its dialogs, which a signed-out listener cannot reach. Confirming signs in with Google again, which returns to the page.
- **Back from the detail view.** Only accounts have Recents; trial listeners return to the start. Opened from Recents, Back goes back in history, so Recents returns at its scroll position; otherwise, such as after a deep link, there is no Recents entry below to return to, and Back opens Recents at the top ([detail view](../../apps/web-app/src/routes/_shell.audiobooks.$conversionId.tsx)).
- **Retry.** The top bar's "…" menu and the page's Retry buttons share one mutation, so a refused retry shows in the notices wherever it was started.
- **Home redirect.** A start from [home](../../apps/web-app/src/routes/index.tsx) that is still pending, resumed after OAuth or waiting out a rate limit, finishes on home, so the redirect of a signed-in listener to Recents skips it. A successful start clears the stored request before it opens the reader.
- **Recents paging.** [Recents](../../apps/web-app/src/routes/_shell.recent.tsx) keeps loading pages, one at a time, while the end of the list stays in reach. A failed page waits for the Retry button, so a persistent failure does not request the page in a loop.

## Consequences

- The account dialog's path is part of the Google sign-in's return, so renaming its route changes where Google sends the listener back.
- Back behaves differently after a deep link than after opening a track from Recents.
