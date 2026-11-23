---
status: accepted
---

# Guard the API server's HTTP edge and keep its errors traceable

The [API server](../../libs/api-server/src/api-server.ts) is the only HTTP edge of the Worker: it serves the web app's assets, the listener and operator APIs, and the telemetry tunnel, and it calls the Durable Objects that own accounts, grants and the registry. A set of small rules about request trust, cross-site requests, ownership and error handling grew in its middleware over several changes: the initial release (1.0.0) and account lifecycle work, the Android App Links change that added the conversion request guard, the move to cup.audio, the local test account in [cup-audio/cup#74](https://github.com/cup-audio/cup/pull/74), conversion deletion in [cup-audio/cup#138](https://github.com/cup-audio/cup/pull/138), the redesign in [cup-audio/cup#101](https://github.com/cup-audio/cup/pull/101), and Sentry reporting in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422) (squashing #403). They were recorded from code comments on 2026-11-23. [Authentication](../architecture/authentication.md) and [observability](../architecture/observability.md) describe the surrounding architecture.

## Decision

Request trust and ownership:

- The [ingress identity](../../libs/api-server/src/http/ingress-identity.ts) never accepts caller-supplied forwarding headers as an ingress identity.
- [Operator access](../../libs/api-server/src/http/operator-access.ts) accepts the shared development token only for trusted development URLs.
- [Account authentication](../../libs/api-server/src/http/account-auth.ts) validates access tokens locally; Cup's lifecycle checks remain authoritative for account access. Only Google identities are accepted, plus the local test account when one is configured ([ADR 0012](0012-offer-a-local-test-account-instead-of-google-in-development.md)). `GOOGLE_WEB_CLIENT_ID` is empty only in local development without a Google client, which disables Google sign-in.
- Supabase identity verification belongs to the authenticated API, before the registry allocates an account ([registry Durable Object](../../libs/registry/src/durable-object/registry-durable-object.ts)).
- The account Durable Object's RPCs are internal: the API must authenticate and resolve ownership before calling them ([account Durable Object](../../libs/accounts/src/durable-object/account-durable-object.ts)). The ownership middleware admits a request for the owner alone, so a handler behind it may sign media URLs for that owner. Deleting an account conversion acts only on the caller's own account, so another account's conversion or a trial conversion is not found.

Cross-site requests:

- The conversion request guard rejects browser requests from another site by `Sec-Fetch-Site: cross-site`; native HTTP requests can omit Fetch Metadata, so its absence is allowed.
- It also requires the custom header `X-Create-Audiobook-From-URL-Request: 1`, which a cross-origin browser request cannot send without a CORS preflight.

Hostnames and assets:

- [Domain routing](../../libs/api-server/src/http/domain-routing.ts) sends requests for former and alternate hostnames to the canonical domain, so historical links keep working. The redirect omits a fragment, so browsers carry the original trial credential in the fragment to the canonical domain.
- `/index.html` answers 404: the shell is internal, and other existing assets also include Vite's development modules.
- An asset response's headers are immutable, so the handler returns a copy; the secure headers middleware and the Cache-Control middleware set headers on the response the handler returns.

Telemetry and errors:

- The trace ID middleware runs first, so every error body carries the Sentry trace ID, also the body of an error that a later middleware throws and `onError` answers. Error bodies carry it so that a reported reference finds the request's trace. Sentry's request wrapper makes the request's span active; without one, as in tests that call the app directly, the scope's propagation context still holds a trace ID.
- Hono's own 4xx, such as the validator's answer to a malformed JSON body, is the client's fault: it keeps its status and opens no issue.
- Hono hands other errors to `onError` instead of rethrowing them, so Sentry's handler wrapper never sees them; `onError` captures them itself.
- The operator-mutation log record carries no operator email, since no log record carries an email address. Like every Sentry log record, it carries the request's trace ID, the one error bodies carry.
- The telemetry tunnel lets the client SDK post its envelopes on Cup's own domain, past ad blockers. It is not part of the listener API, and its path avoids "sentry" so filter lists miss it. It is same-origin in the browser; the Android and iOS shells post from their own origins without credentials. It exposes `Retry-After` and `X-Sentry-Rate-Limits`, from which the client SDK reads its rate limits. It forwards to the DSNs in `SENTRY_TUNNEL_DSNS`, comma-separated: `cup-app` in production, empty elsewhere. Workers type `cf` as incoming or outgoing request properties, which leaves `country` unknown, so the handler checks it at runtime.

- Fresh authentication, which lifecycle confirmations require, counts only the sign-in method of the identity's own provider ([account authentication](../../libs/api-server/src/http/account-auth.ts)).

## Consequences

- Removing the Fetch Metadata check or the custom header reopens cross-site conversion requests.
- Any new middleware must run after the trace ID middleware, and any handler that catches an error itself must capture it, since Sentry's wrapper does not see what Hono handles.
- Renaming the tunnel path to anything containing "sentry" would let ad blockers drop client telemetry.
