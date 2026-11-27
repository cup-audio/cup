# Web App Agent Instructions

## Scope

- Applies to `apps/web-app/**`.
- Follow the root `AGENTS.md` for package manager, validation, testing, and commits.

## Layout

- `src/app/**`: React UI and styling.
- `src/app/design-system/**`: reusable UI primitives.

## Local Conventions

- Use package imports such as `#src/...`.
- Prefer `DSButton` over raw buttons for app UI, and `DSIconButton` with an icon from `src/app/design-system/icons.tsx` for icon-only controls.
- Redesigned screens use the text styles in `src/app/design-system/text-styles.ts` and spread `interTypefaceScope` from `src/app/global-styles.ts` on their root, so the global Space Mono rule for `span` and `input` stays out of them; the design-system story shows the tokens, text styles, icons and components.
- Verify a screen against its design with the [fidelity check](../../qa/fidelity-check/README.md).
- Define all `useMutation` hooks in `src/data-fetching/*` files and import those hooks into components and routes.
- Write XState machines in v6 syntax, not v5: each event gets one function that returns `{ target, context }` and queues effects on `enq`. Read the docs that ship with the installed version in `node_modules/xstate/docs/`. Call `enq` only after every early `return undefined`, because any `enq` call marks the event handled and stops it reaching the parent state.
- Use `useAppForm` for forms; follow `src/app/components/source-url-form.tsx`.
- Send API calls through `requestApi` in `src/data-fetching/api-request.ts`: choose `"none"`, `"optional"`, or `{ subject }` account authorization and call a `ListenerApiClient` or `AuthenticatedRpcClient` method from `@cup/listener-api.client` (see `libs/listener-api.client/src/rpc-client.ts` from the repo root). Handle failed responses as `RpcError`, matching on `status` or on `code` compared with `ERROR_CODE`, never with a string literal; import both, like the app's own error classes, from `src/errors.ts`, which imports no other app module. Lint enforces all three: `fetch` is a restricted global, only `api-request.ts` and the session machine plumbing in `src/auth/account-session.ts` may import `#src/api-client.js`, and only `errors.ts` may import `RpcError` or `ERROR_CODE` from `@cup/listener-api.client` ([`oxlint.config.ts`](oxlint.config.ts)).
- Keep the module graph free of import cycles; lint fails on one (`import/no-cycle`). The account session asks the query client to clear its cache with a window event (`src/data-fetching/query-cache-events.ts`) rather than importing it, so the session stays below the query client.

## Commands

- During development: the narrowest check that covers the change, such as `pnpm --filter '@cup/web-app' test:components`. Before review, merge, and deploy: the matching [validation gate](../../AGENTS.md#validation-gates) from the repo root.
- Run locally through its host: `pnpm --filter '@cup/cloudflare-worker' dev`.
