import type { CloudflareOptions } from "@sentry/cloudflare";

import { createWorkerSentryOptions, type WorkerComponent } from "@cup/telemetry.cloudflare";

export function sentryOptionsFor(component: WorkerComponent): (env: object) => CloudflareOptions {
  return (env) => createWorkerSentryOptions(env, component);
}
