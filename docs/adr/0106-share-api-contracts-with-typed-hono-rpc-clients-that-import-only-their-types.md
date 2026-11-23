---
status: accepted
---

# Share API contracts with typed Hono RPC clients that import only their types

The listener and operator APIs are defined once as zod contracts and Hono routes ([API definitions](../architecture/README.md#api-definitions)), and their clients are typed from them. The clients run in the browser, the shells and the operator CLI, so they must not bundle the contracts' runtime, and every unsuccessful response, including a proxy's, must reach callers as one typed error. [cup-audio/cup#15](https://github.com/cup-audio/cup/pull/15) shared the RPC response handling across both clients, and [cup-audio/cup#38](https://github.com/cup-audio/cup/pull/38) typed the API error codes and snapshotted the OpenAPI documents. Later contract details came with [cup-audio/cup#20](https://github.com/cup-audio/cup/pull/20), [cup-audio/cup#35](https://github.com/cup-audio/cup/pull/35), [cup-audio/cup#51](https://github.com/cup-audio/cup/pull/51), [cup-audio/cup#101](https://github.com/cup-audio/cup/pull/101), [cup-audio/cup#138](https://github.com/cup-audio/cup/pull/138) and [cup-audio/cup#488](https://github.com/cup-audio/cup/pull/488). [ADR 0010](0010-tolerate-unknown-keys-at-the-listener-api.md) records which schemas tolerate unknown keys. These decisions were recorded from code comments on 2026-11-23.

## Decision

### Typed clients

- **The route packages export a precomputed client type**, following Hono's advice to compile the code before using the RPC client (<https://hono.dev/docs/guides/rpc#compile-your-code-before-using-it-recommended>), in the [listener](../../libs/listener-api.routes/src/hono-client.ts) and [operator](../../libs/operator-api.routes/src/hono-client.ts) route packages.
- **Each client wraps `hc` in an indirection** (`hcWithType`), which preserves the inferred routes and works around TypeScript issue 47663 ([listener client](../../libs/listener-api.client/src/hono-client.ts), [operator client](../../libs/operator-api.client/src/hono-client.ts)). Base URLs lose one trailing slash, so Hono joins API paths onto them cleanly.
- **A client imports only the contract's types.** Its `ERROR_CODE` repeats the contract's error codes as the client's own value, so the client does not bundle the contract's runtime ([listener](../../libs/listener-api.client/src/rpc-error.ts), [operator](../../libs/operator-api.client/src/rpc-error.ts)). It declares the constant with `satisfies ErrorCodeConstants<ErrorCode>` (one `SCREAMING_SNAKE_CASE` key per code, [shared RPC response](../../libs/api-rpc.client/src/rpc-response.ts)), so it fails to compile when a code is missing there or is not in the contract. The contracts' `ERROR_CODE` lists every `code` of the API's error responses, including those of the server-wide middleware that also guards its routes.
- **The shared contracts stay runtime-independent.** [`@cup/conversion-contracts`](../../libs/conversion-contracts/oxlint.config.ts) restricts its imports because the Worker, the workflows and, through the listener contracts, the browser load it.

### Unsuccessful responses

- **Every unsuccessful response throws the client's `RpcError`**, a subclass of the shared [`RpcError`](../../libs/api-rpc.client/src/rpc-response.ts) per client package, so `instanceof` narrows to the client's code type. The parser preserves Hono's inferred successful payload.
- **A response without a known error code gets the fallback code** (`operational-error`), such as a proxy's HTML error page or a code this client does not know yet.
- **`retryAfter` is the `Retry-After` header, or 60 seconds when it is absent.**
- **`traceId` is Sentry's trace ID of the request**, from the error envelope, which finds the request's trace in Sentry's search; it is absent when the response carried none.
- **Hono's JSON validator throws its own 400 `HTTPException`**, which the API answers as it is.

### Contract details

- **An unknown preparation phase parses as absent** in listener responses, so a newer Worker can add phases without failing the response ([listener contracts](../../libs/listener-api.routes/src/contracts.ts)). The unknown value is dropped by preprocessing, which keeps the enum in the OpenAPI document, since the document describes the schema after the preprocessing step.
- **Audiobook `segments` hold one entry per synchronization unit, in document order**, and a history item's `coverImage` is present exactly when `hasCoverImage` is.
- **Every operator mutation carries `Content-Type: application/json`** (the `/api/operator/*` middleware in `@cup/api-server`), so bodyless operator mutations take an empty JSON object ([operator routes](../../libs/operator-api.routes/src/hono-app.ts)). Deleting a conversion whose account is being deleted answers 404 with `account-unavailable`, as account inspection answers. The listener's bodyless conversion deletion likewise sends the JSON content type, which the session-mutation guard requires ([listener client](../../libs/listener-api.client/src/rpc-client.ts)).
- **A request that fails its route's schemas answers `400 invalid-input`** through the routes' `defaultHook`; the OpenAPI tests check that every operation with request schemas declares that 400. Routes registered with their own hook answer validation failures differently: the operator's account inspection answers an invalid account ID with `404 account-unavailable`, like an unknown account, and no listener route has its own hook yet.
- **The ledger cursor has at most 15 digits**, so every valid cursor is a safe integer ([operator contracts](../../libs/operator-api.routes/src/contracts.ts)).
- **An account listing's `usage` is absent until the Registry has received the account's first usage projection.**

### Operator access

- **Only the production default export validates Cloudflare Access.** `libs/api-server` tests inject the operator access check; the Worker's production default export wires the Cloudflare Access validation, which must not accept the development operator token on a public hostname. [`operator-api.test.ts`](../../apps/cloudflare-worker/test/operator-api.test.ts) checks that the development token works on localhost but not on the canonical domain.

## Consequences

- Adding an error code to a contract fails the client's build until the client lists it too.
- Callers handle one error class per client, whatever answered the request.
