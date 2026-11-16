import type { CloudflareOptions } from "@sentry/cloudflare";
import { extraErrorDataIntegration } from "@sentry/cloudflare";

import { CupError } from "@cup/errors";
import { beforeSendLog, TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

import { beforeSendServerEvent, beforeSendServerSpan } from "#src/server-before-send.ts";

/** The Worker entry points Sentry wraps; each event names its own as the `cup.component` tag. */
export type WorkerComponent =
  | "fetch"
  | "account-durable-object"
  | "conversion-grant-durable-object"
  | "registry-durable-object"
  | "prepare-audiobook-workflow"
  | "synthesize-audio-segment-workflow";

/** The Worker variables and bindings the options read; every Cup Worker environment has them. */
export type WorkerSentryEnvironment = {
  LOCAL_DEVELOPMENT: string;
  /** The `cup-worker` DSN in production, empty in local development. */
  SENTRY_DSN: string;
  CF_VERSION_METADATA: { id: string };
};

/**
 * The bindings to this Worker's own Durable Objects. Sentry appends the trace context to every RPC
 * call on them as a trailing argument, which only a Sentry-wrapped receiver strips again: the
 * Worker entry (`apps/cloudflare-worker/src/index.ts`) wraps all three classes.
 */
const DURABLE_OBJECT_BINDINGS = ["ACCOUNTS", "CONVERSION_GRANTS", "REGISTRY"];

/**
 * The path of the Listener API's health endpoint, which Sentry's uptime monitor checks every
 * minute. Its traces would be near-empty and use up about 43k spans of the monthly quota.
 */
const HEALTH_PATH = "/api/health";

/** Traces every invocation except the uptime monitor's health checks. */
function sampleWorkerTrace({ attributes }: { attributes?: Record<string, unknown> }): number {
  return attributes?.["url.path"] === HEALTH_PATH ? 0 : 1;
}

/**
 * Sentry's options for one Worker entry point, by the on/off rule: Sentry runs exactly when
 * `LOCAL_DEVELOPMENT` is not `"true"`, and `SENTRY_DSN` must agree. A contradiction throws on every
 * invocation, so a misconfigured environment can neither send from local development nor stay quiet
 * in production.
 *
 * `env` is the entry point's whole environment; each Durable Object and Workflow class declares its
 * own environment type, so this checks the {@link WorkerSentryEnvironment} fields at runtime.
 */
export function createWorkerSentryOptions(
  env: object,
  component: WorkerComponent,
): CloudflareOptions {
  assertWorkerSentryEnvironment(env);
  const isLocalDevelopment = env.LOCAL_DEVELOPMENT === "true";
  if (isLocalDevelopment && env.SENTRY_DSN !== "") {
    throw new CupError(
      'SENTRY_DSN must be empty when LOCAL_DEVELOPMENT is "true": local development never sends to Sentry.',
    );
  }
  if (!isLocalDevelopment && env.SENTRY_DSN === "") {
    throw new CupError(
      'SENTRY_DSN must be set when LOCAL_DEVELOPMENT is not "true": production always reports to Sentry.',
    );
  }
  if (isLocalDevelopment) {
    // `dsn` stays unset: the SDK would otherwise fall back to `env.SENTRY_DSN` on its own.
    return { enabled: false };
  }

  return {
    dsn: env.SENTRY_DSN,
    // Set explicitly: the SDK derives it from CF_VERSION_METADATA too, but not for Workflow events.
    release: env.CF_VERSION_METADATA.id,
    environment: "production",
    // A tag on errors; an attribute on logs and streamed spans, which take no tags.
    initialScope: {
      tags: { [TELEMETRY_ATTRIBUTES.COMPONENT]: component },
      attributes: { [TELEMETRY_ATTRIBUTES.COMPONENT]: component },
    },
    // Every key is set: an omitted key falls back to the SDK's permissive default.
    dataCollection: {
      userInfo: false,
      httpHeaders: { request: false, response: false },
      cookies: false,
      httpBodies: [],
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      // Collected, then masked by the hooks below, so non-credential parameters stay readable.
      urlQueryParams: true,
    },
    tracesSampler: sampleWorkerTrace,
    traceLifecycle: "stream",
    // Durable Object SQL and storage calls would outnumber every other span.
    ignoreSpans: [{ op: "db.query" }, /^durable_object_storage_/],
    // No trace headers to third parties; incoming traces continue only from Cup's own organisation.
    tracePropagationTargets: [],
    propagateTraceparent: false,
    strictTraceContinuation: true,
    rpcTracePropagationBindings: DURABLE_OBJECT_BINDINGS,
    // The default integrations stay, except Dedupe; Zod, Supabase and console capture are not
    // among them. Dedupe drops an event equal to the one the client processed before it, and that
    // one can be a capture of Sentry's own wrappers that `beforeSend` drops later: the Durable
    // Object wrapper's capture of the error an RPC caller then captures, or the Workflow wrapper's
    // capture of a failed step. Every Durable Object and Workflow of an isolate shares one cached
    // client, so Dedupe would drop the caller's capture, the one Cup sends. Cup captures each
    // failure once anyway.
    integrations: (defaultIntegrations) => [
      ...defaultIntegrations.filter((integration) => integration.name !== "Dedupe"),
      extraErrorDataIntegration(),
    ],
    beforeSend: beforeSendServerEvent,
    beforeSendSpan: beforeSendServerSpan,
    // Logs are always on in SDK 11; only `logEvent` writes them, and this drops `debug`.
    beforeSendLog,
    // Cup sends no metrics.
    beforeSendMetric: () => null,
  };
}

function assertWorkerSentryEnvironment(env: object): asserts env is WorkerSentryEnvironment {
  const isValid =
    "LOCAL_DEVELOPMENT" in env &&
    typeof env.LOCAL_DEVELOPMENT === "string" &&
    "SENTRY_DSN" in env &&
    typeof env.SENTRY_DSN === "string" &&
    "CF_VERSION_METADATA" in env &&
    typeof env.CF_VERSION_METADATA === "object" &&
    env.CF_VERSION_METADATA !== null &&
    "id" in env.CF_VERSION_METADATA &&
    typeof env.CF_VERSION_METADATA.id === "string";
  if (!isValid) {
    throw new CupError(
      "The Worker environment needs the LOCAL_DEVELOPMENT and SENTRY_DSN vars and the CF_VERSION_METADATA binding.",
    );
  }
}
