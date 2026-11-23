---
status: accepted
---

# Capture each Worker failure once at Cup's boundary and drop Sentry's wrapper captures

Sentry's `@sentry/cloudflare` wraps the Worker's Durable Objects and Workflows, and its wrappers capture errors on their own: the Durable Object wrapper every error an RPC method or the alarm throws, the Workflow wrapper a step's last failed attempt. Cup's capture rule captures each failure once, at the boundary where Cup knows what failed, so the wrappers' captures would duplicate or pre-empt Cup's. It was decided with the observability spec [cup-audio/cup#403](https://github.com/cup-audio/cup/issues/403) for Linear CUP-37 and implemented in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **The Worker's `beforeSend` drops the wrappers' own captures** by their mechanism ([server before-send](../../libs/telemetry.cloudflare/src/server-before-send.ts)). The Workflow wrapper captures a step's last failed attempt, though the run goes on and Cup captures only the instance's final failure. The Durable Object wrapper captures every error an RPC method or the alarm throws, though the caller captures an RPC error at its boundary, and the alarm captures its own failure. For example, when validating a session of a grant that was never initialized throws a `CupError` in the grant's Durable Object, the wrapper captures it before the RPC call hands it to the server.
- **An alarm captures its own failure** with [`captureAlarmFailure`](../../libs/telemetry.cloudflare/src/alarm-failure.ts): it captures the error a pass throws and rethrows it, so the platform still retries the alarm. Nothing above the alarm captures it, because `beforeSend` drops the Durable Object wrapper's captures, which it cannot tell apart from those of RPC errors that the caller captures. The error is marked as captured, so the wrapper does not capture it a second time.
- **Cup's captures clear Sentry's captured marker first** ([`forgetWrapperCapturesIntegration`](../../libs/telemetry.cloudflare/src/forget-wrapper-captures.ts)). Sentry sets `__sentry_captured__` on every error it captures and silently never captures a marked error again. The Durable Object wrapper marks the error an RPC method throws, and the RPC call copies the mark onto the error its caller receives, such as the API server or a Workflow step; the Workflow wrapper marks the error of a step's last failed attempt, which the run captures again. Every capture that is not a wrapper's therefore clears the mark, so each of Cup's own captures reaches Sentry.
- **The Dedupe integration is off** ([Worker Sentry options](../../libs/telemetry.cloudflare/src/worker-sentry-options.ts)); the other default integrations stay. Dedupe drops an event equal to the one the client processed before it, and that one can be a wrapper capture that `beforeSend` drops later: the Durable Object wrapper's capture of the error an RPC caller then captures, or the Workflow wrapper's capture of a failed step. Every Durable Object and Workflow of an isolate shares one cached client, so Dedupe would drop the caller's capture, the one Cup sends. Cup captures each failure once anyway.

## Consequences

- A failure reaches Sentry exactly once, from Cup's own capture, with the context Cup's boundary adds.
- Code that runs outside an RPC caller's or a Workflow run's capture, such as an alarm pass, must capture its own failure.
