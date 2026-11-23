---
status: accepted
---

# Rate-limit with a serialized rolling window

Sign-ups and conversions are rate-limited per bucket (`SIGNUP_IP_LIMIT`, `CONVERSION_IP_LIMIT`, `CONVERSION_OWNER_LIMIT` in [`wrangler.jsonc`](../../apps/cloudflare-worker/wrangler.jsonc)). A fixed-window counter lets a client spend a window's whole allowance at the end of one window and again at the start of the next. The limiter dates back at least to [cup-audio/cup#16](https://github.com/cup-audio/cup/pull/16), which moved the grant rate events into a shared library. This decision was recorded from a code comment on 2026-11-23.

## Decision

[`RollingLimits`](../../libs/rolling-limits/src/rolling-limits.ts) is a serialized rolling window, with no fixed-window boundary burst: it stores one row per accepted event in the Durable Object's SQLite and, inside one transaction, counts the bucket's events newer than `now - window` before inserting another. A refused call returns the seconds until the oldest counted event leaves the window.

## Consequences

- Every accepted event is a stored row until it expires, and an alarm deletes expired rows.
- Counting and inserting run in one Durable Object transaction, so concurrent requests cannot both take the last slot.
