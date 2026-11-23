import type { CloudflareOptions } from "@sentry/cloudflare";
import { extraErrorDataIntegration } from "@sentry/cloudflare";

import { CupError } from "@cup/errors";
import { beforeSendLog, TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

import { forgetWrapperCapturesIntegration } from "#src/forget-wrapper-captures.ts";
import { beforeSendServerEvent, beforeSendServerSpan } from "#src/server-before-send.ts";

export type WorkerComponent =
  | "fetch"
  | "account-durable-object"
  | "conversion-grant-durable-object"
  | "registry-durable-object"
  | "prepare-audiobook-workflow"
  | "synthesize-audio-segment-workflow";

export type WorkerSentryEnvironment = {
  LOCAL_DEVELOPMENT: string;
  SENTRY_DSN: string;
  CF_VERSION_METADATA: { id: string };
};

const DURABLE_OBJECT_BINDINGS = ["ACCOUNTS", "CONVERSION_GRANTS", "REGISTRY"];

const HEALTH_PATH = "/api/health";

function sampleWorkerTrace({ attributes }: { attributes?: Record<string, unknown> }): number {
  return attributes?.["url.path"] === HEALTH_PATH ? 0 : 1;
}

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
    return { enabled: false };
  }

  return {
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA.id,
    environment: "production",
    initialScope: {
      tags: { [TELEMETRY_ATTRIBUTES.COMPONENT]: component },
      attributes: { [TELEMETRY_ATTRIBUTES.COMPONENT]: component },
    },
    dataCollection: {
      userInfo: false,
      httpHeaders: { request: false, response: false },
      cookies: false,
      httpBodies: [],
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      urlQueryParams: true,
    },
    tracesSampler: sampleWorkerTrace,
    traceLifecycle: "stream",
    ignoreSpans: [{ op: "db.query" }, /^durable_object_storage_/],
    tracePropagationTargets: [],
    propagateTraceparent: false,
    strictTraceContinuation: true,
    rpcTracePropagationBindings: DURABLE_OBJECT_BINDINGS,
    integrations: (defaultIntegrations) => [
      ...defaultIntegrations.filter((integration) => integration.name !== "Dedupe"),
      extraErrorDataIntegration(),
      forgetWrapperCapturesIntegration(),
    ],
    beforeSend: beforeSendServerEvent,
    beforeSendSpan: beforeSendServerSpan,
    beforeSendLog,
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
