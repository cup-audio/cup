---
status: accepted
---

# Test Durable Objects in a Wrangler harness through test objects and stubs

The account, grant, registry and deletion coordinator Durable Objects are tested in a Wrangler test harness ([registry tests](../../libs/registry/test/worker.ts)), and the API server's handlers in plain Vitest. The harness, the platform and Sentry each behave in ways that would make tests racy, slow or blind unless the tests are shaped around them. These choices came from the account lifecycle work, the Resend stub in [cup-audio/cup#37](https://github.com/cup-audio/cup/pull/37), the ledger tests in [cup-audio/cup#52](https://github.com/cup-audio/cup/pull/52), the operator inspection shapes in [cup-audio/cup#29](https://github.com/cup-audio/cup/pull/29), Sentry reporting in [cup-audio/cup#422](https://github.com/cup-audio/cup/pull/422), and narration document rendering in [cup-audio/cup#502](https://github.com/cup-audio/cup/pull/502). They were recorded from code comments on 2026-11-23. The [Resend stub](../../qa/resend-stub/README.md) and the [Sentry stub](../../qa/sentry-stub/README.md) document the stubs.

## Decision

Test objects ([test worker](../../libs/registry/test/worker.ts)):

- The account test object lets ledger and lifecycle tests settle conversions directly without running preparation. Synthesis dispatch is accepted but never runs, so tests complete or release segments themselves. Preparation dispatch fails until a test accepts it, and accepted preparation never runs either. Workflow instances report no status, so the alarm treats them as unreachable, unless a test reports one for an instance or stops them all. They record each termination attempt, which fails once a test asks for it or, as on the platform, once the instance has finished (`complete`, `errored` or `terminated`). The registry passes through, except that removing a conversion owner fails once, and applying a usage projection fails from then on, when a test asks for it. Reconciling an artifact writer, the alarm step that runs first, fails once a test asks for it.
- The grant test object accepts preparation and synthesis dispatch but never runs it, and its Workflow instances report no status, so the alarm treats them as unreachable and changes nothing. Once a test stops the Workflows, every instance reports `terminated`; releasing a segment fails once a test asks for it.
- An alarm the platform fires is only counted or does nothing: tests run the alarm explicitly (`reconcileForTest()`, `reconcileAtForTest()`), so a pass never races the test. A rejection does not reach the test through the harness, so the test objects return the message of the error a pass threw.
- Wrangler masks rejected RPC error messages, so tests pair rejection checks with assertions on persisted state ([accounts tests](../../libs/registry/test/accounts.test.ts)).
- The [holding ACCOUNTS double](../../libs/registry/test/holding-accounts.ts) wraps the real namespace and holds the next call of a chosen account method until the test releases it. While the deletion coordinator awaits an account RPC, its Durable Object's input gate is open, so another call, such as a restore delivery, can land on the coordinator in between; the hold makes that interleaving happen the same way every time. Production code knows nothing about it: the test passes the wrapped namespace as `ACCOUNTS`.

Stubs and Sentry:

- Registry tests that send through the Resend stub pass its origin explicitly, so nothing reaches Resend. Only the Sentry-wrapped test objects run Sentry, which sends to the discard port unless a test points `SENTRY_DSN` at a Sentry stub ([test Wrangler configuration](../../libs/registry/wrangler.test.jsonc)).
- Each Sentry test waits for several end-of-invocation flushes from the Durable Object to the stub. To show that a pass that sends nothing has flushed, it is followed by a pass that reports a second conversion of the same owner, and the test waits for that event ([stuck conversion tests](../../libs/registry/test/stuck-conversions.test.ts)).
- Sentry's Dedupe integration drops an immediate repeat of the same event, which would hide a repeated report. Tests that expect repeated reports therefore use two stuck attempts or deletions marked apart, so that every repeat follows a different event ([deletion coordinator tests](../../libs/registry/test/deletion-coordinator.test.ts)).

API server tests:

- Vitest runs test files without isolation, so test files share loaded modules; a copy of a module loaded before a mock applied would capture to Sentry for real, so a test that needs the mocked capture resets modules and loads fresh ([authenticate account tests](../../libs/api-server/test/authenticate-account.test.ts)).
- A module mock that keeps a generic function names the module as a string, because the typed form would require the mock to keep the function's type parameter, which a `Mock` drops ([narration document rendering tests](../../libs/api-server/test/narration-document-rendering.test.ts)).
- The operator access fixture is typed by the account's result types rather than the operator contract, so it can hold anything the account returns, and the strict parse of the response checks that the contract accepts it ([operator access tests](../../libs/api-server/test/operator-access.test.ts)).

- When a test waits for warnings from two alarm passes, the second pass runs after the first, so once its warnings arrive the first pass's have too ([conversion outcome tests](../../libs/registry/test/conversion-outcomes.test.ts)).

## Consequences

- Behaviour that only the real Workflows exercise, such as preparation and synthesis themselves, is not covered by these tests.
- A new Sentry assertion has to follow the flush and Dedupe rules above, or it passes or fails depending on timing.
