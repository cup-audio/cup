---
status: accepted
---

# Toast API failures unless the screen shows them in place

The web app reaches the listener API through TanStack Query and one request function. Every failure needs one place to be reported, a polling query must not flood the listener with notices, and a refetch can find that what a screen shows was deleted elsewhere. [cup-audio/cup#11](https://github.com/cup-audio/cup/pull/11) introduced toasts and the shared error screen, [cup-audio/cup#165](https://github.com/cup-audio/cup/pull/165) added the query key registry, the "not found" handling and the cache rules of [ADR 0016](0016-keep-the-query-cache-for-the-page-lifetime-and-load-screens-in-route-loaders.md), [cup-audio/cup#138](https://github.com/cup-audio/cup/pull/138) added the player's audiobook refresh, [cup-audio/cup#51](https://github.com/cup-audio/cup/pull/51) enforced `requestApi` with a lint rule, and the commit "feat(accounts): add social signup and account lifecycle" added the rate-limit countdown. These decisions were recorded from code comments on 2026-11-23.

## Decision

- **One request function.** [`requestApi`](../../apps/web-app/src/data-fetching/api-request.ts) sends each API request with a freshly resolved account token. Grant sessions travel as cookies independently of the account authorization it is given: `"none"` sends no account token; `"optional"` sends the signed-in account's token if there is one, for example for an article that a conversion grant or an account may own; `{ subject }` requires the account the request was issued for to still be signed in and rejects before dispatch otherwise. Unsuccessful responses reject with `RpcError`; a missing or changed required account rejects with a plain `Error` before the request is sent. The [lint configuration](../../apps/web-app/oxlint.config.ts) exempts only the request module itself and the account session facade, whose auth configuration request runs below account sessions and so cannot go through `requestApi`.
- **Toast by default.** The [query client](../../apps/web-app/src/data-fetching/query-client.ts) shows failures with a toast. A query or mutation whose component shows the failure in place opts out with an `errorDisplay` of `"inline"`.
- **Wording.** Server failures, lost connections and app bugs carry no message meant for users; a server failure carries the reference that finds it in Sentry ([errors](../../apps/web-app/src/errors.ts)).
- **One toast per polling failure.** A polling query keeps failing while the connection is down; one toast covers all attempts.
- **Drop data that is gone.** When a refetch is answered "not found" or "access denied", what the screen shows was deleted or is no longer the listener's, for example after a change on another device. The query client drops the data, which makes the screen's suspense query throw to its error screen, as on a first load, and keeps a later visit from showing it.
- **Query keys by data owner.** [Every query key](../../apps/web-app/src/data-fetching/query-keys.ts) is built in one module, grouped by the owner of the server data, so an API write invalidates everything it may change by one key prefix. Queries and cache edits build keys only there.
- **Player refresh outside the audiobook query.** The player requests the audiobook again for a newly signed narration track URL and shares the response with its page ([reader data](../../apps/web-app/src/data-fetching/reader.ts)). It resolves to `null` when the conversion no longer exists, which the player shows in place, so only other failures get a toast. It bypasses the audiobook query, because a failed query that has data always shows a toast.
- **History membership.** Whether the signed-in account's history lists a conversion tells the account's own conversion from a trial one the listener can also open ([account history](../../apps/web-app/src/data-fetching/account-history.ts)). The lookup loads further history pages until it finds the conversion or runs out of pages, is `false` until then, and never polls itself.
- **Rate limits.** When a rate limit expires, the start form enables a manual retry; it never submits a saved URL automatically ([rate limit](../../apps/web-app/src/data-fetching/rate-limit.ts)).

## Consequences

- A new screen that shows its failure in place must opt out of the toast, or the failure shows twice.
- Deleted or revoked data leaves the cache on the next refetch, without each screen handling "not found".
- A new query key outside `query-keys.ts` escapes the prefix invalidation.
