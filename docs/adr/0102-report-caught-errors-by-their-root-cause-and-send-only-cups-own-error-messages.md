---
status: accepted
---

# Report caught errors by their root cause and send only Cup's own error messages

A dependency's error message can embed data that must never reach telemetry, such as the SQL parameters in a Drizzle query error, and a plain `Error` is no safer than any other foreign class. [ADR 0030](0030-observe-production-with-sentrys-own-sdks-and-turn-cloudflares-observability-off.md) states the consequence that foreign error messages never leave the Worker; this record keeps how the code enforces it. It was decided with the observability spec [cup-audio/cup#403](https://github.com/cup-audio/cup/issues/403) for Linear CUP-37 and implemented in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422). These decisions were recorded from code comments on 2026-11-23.

## Decision

- **Cup's own errors are `CupError`s.** [`CupError`](../../libs/errors/src/cup-error.ts) is the base class of every error Cup throws in Worker code, and telemetry keeps the message only of these errors, because Cup writes them itself.
- **The brand survives Durable Object RPC.** `CupError` carries its brand `cupError = true` as an own enumerable property, because a Durable Object RPC call rebuilds a thrown error as a plain `Error` that keeps only its name, message, stack, cause and own properties. [`isCupError`](../../libs/errors/src/exception-chain.ts) therefore accepts a `CupError` or an error an RPC call rebuilt from one; every other error, a plain `Error` included, is foreign.
- **A caught error is reported by its root cause** (the error that actually went wrong) plus the types of the errors that wrap it, outermost to innermost, in [`describeExceptionChain`](../../libs/errors/src/exception-chain.ts). The root cause's message is kept only for Cup's own errors; a log record carries the wrapper types as `cup.exception.chain` and `exception.message` only for Cup's own errors.
- **A foreign error's stack keeps its frames and loses its first line.** A V8 stack starts with `name: message`, which may span several lines, before its frames, so only the lines that are frames (`at …`) are kept, after the type.
- **The reported type is the constructor's name**, because a class that does not set `name`, such as Drizzle's `DrizzleQueryError`, would otherwise read as `Error`.
- **The Worker's `beforeSend` applies the same rule to events** ([server before-send](../../libs/telemetry.cloudflare/src/server-before-send.ts)): a foreign error in the captured chain keeps its class name as its type, loses its message, and loses the properties `extraErrorDataIntegration` copied from it. `extraErrorDataIntegration` files that data under the error's name, so the hook drops all of it for a foreign error and, for Cup's own, only the copy of the next error in the chain (`cause`) and the `cupError` brand, which says nothing about the failure.
- **A Workflow step rebuilds a thrown `CupError` without its brand**, but the run captures the error the step threw, so the message stays.
- **Sentry's linked-errors integration builds the exception values innermost first, main error last.**

## Consequences

- Throwing a `CupError` is the only way to get a message into telemetry; a foreign error is identified by its type and stack frames alone.
- No request path of the Worker wraps a foreign error today, so the Worker integration tests cannot provoke this case; [`worker-sentry-pipeline.test.ts`](../../libs/telemetry.cloudflare/test/worker-sentry-pipeline.test.ts) runs the Worker options through Sentry's own Cloudflare SDK against the Sentry stub instead, so the linked-errors and extra-error-data integrations build the event that `beforeSend` scrubs.
