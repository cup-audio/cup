import type { CloudflareOptions } from "@sentry/cloudflare";

import { createWorkerSentryOptions, type WorkerComponent } from "@cup/telemetry.cloudflare";

/**
 * The options callback that `src/index.ts` passes to Sentry's wrapper of one entry point. Sentry
 * calls it with the entry point's environment on every invocation, so a `SENTRY_DSN` that
 * contradicts `LOCAL_DEVELOPMENT` fails every invocation.
 */
export function sentryOptionsFor(component: WorkerComponent): (env: object) => CloudflareOptions {
  return (env) => createWorkerSentryOptions(env, component);
}
