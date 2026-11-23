import type { CapacitorOptions } from "@sentry/capacitor";
import {
  browserSessionIntegration,
  extraErrorDataIntegration,
  makeFetchTransport,
  reportingObserverIntegration,
  spanStreamingIntegration,
  tanstackRouterBrowserTracingIntegration,
  withStreamedSpan,
} from "@sentry/react";

import {
  beforeSendLog,
  CUP_APP_DSN,
  maskSpanUrls,
  TELEMETRY_ATTRIBUTES,
  TELEMETRY_TUNNEL_PATH,
} from "@cup/telemetry.core";

import { beforeBreadcrumbClient, beforeSendClientEvent } from "#src/client-before-send.ts";

export type ClientTelemetryContext = {
  pageOrigin: string;
  apiOrigin: string;
  release: string | undefined;
  router: object;
  shell?: ShellTelemetryContext;
};

export type ShellTelemetryContext = {
  isDebugBuild: boolean;
  testSentryDsn: string | undefined;
  shouldSendCrashReports: boolean;
  app: { version: string; build: string };
};

const PRODUCTION_ORIGIN = "https://cup.audio";

const SHELL_APP_ID = "audio.cup.app";

const IGNORED_ERRORS = [/^ResizeObserver loop/, /^AbortError: /];

export function createClientSentryOptions({
  pageOrigin,
  apiOrigin,
  release,
  router,
  shell,
}: ClientTelemetryContext): CapacitorOptions | undefined {
  const target =
    shell === undefined
      ? browserTarget(pageOrigin, release)
      : shellTarget(apiOrigin, release, shell);
  if (target === undefined) {
    return undefined;
  }

  return {
    ...target,
    transport: makeFetchTransport,
    tunnel: `${apiOrigin}${TELEMETRY_TUNNEL_PATH}`,
    sendDefaultPii: false,
    enableLogs: true,
    beforeSendLog,
    tracesSampler: () => 1.0,
    traceLifecycle: "stream",
    tracePropagationTargets: [new RegExp(`^${escapeRegExp(apiOrigin)}/`)],
    propagateTraceparent: false,
    strictTraceContinuation: false,
    integrations: [
      spanStreamingIntegration(),
      tanstackRouterBrowserTracingIntegration(router, {
        enableLongAnimationFrame: true,
        linkPreviousTrace: "session-storage",
      }),
      browserSessionIntegration({ lifecycle: "route" }),
      extraErrorDataIntegration(),
      reportingObserverIntegration(),
    ],
    ignoreErrors: IGNORED_ERRORS,
    beforeSend: beforeSendClientEvent,
    beforeSendSpan: withStreamedSpan(maskSpanUrls),
    beforeBreadcrumb: beforeBreadcrumbClient,
  };
}

type SendTarget = Pick<
  CapacitorOptions,
  | "dsn"
  | "release"
  | "dist"
  | "environment"
  | "initialScope"
  | "enableNative"
  | "enableAutoSessionTracking"
  | "enableWatchdogTerminationTracking"
  | "attachThreads"
  | "cocoaOptions"
>;

function browserTarget(pageOrigin: string, release: string | undefined): SendTarget | undefined {
  if (pageOrigin !== PRODUCTION_ORIGIN) {
    return undefined;
  }
  return {
    dsn: CUP_APP_DSN,
    ...(release === undefined ? {} : { release }),
    environment: "production",
  };
}

function shellTarget(
  apiOrigin: string,
  webRelease: string | undefined,
  { isDebugBuild, testSentryDsn, shouldSendCrashReports, app }: ShellTelemetryContext,
): SendTarget | undefined {
  const dsn = isDebugBuild
    ? testSentryDsn
    : apiOrigin === PRODUCTION_ORIGIN
      ? CUP_APP_DSN
      : undefined;
  if (dsn === undefined) {
    return undefined;
  }

  return {
    dsn,
    release: `${SHELL_APP_ID}@${app.version}+${app.build}`,
    dist: app.build,
    environment: isDebugBuild ? "debug" : "production",
    ...(webRelease === undefined
      ? {}
      : { initialScope: { tags: { [TELEMETRY_ATTRIBUTES.WEB_RELEASE]: webRelease } } }),
    enableNative: shouldSendCrashReports,
    enableAutoSessionTracking: false,
    enableWatchdogTerminationTracking: false,
    attachThreads: true,
    cocoaOptions: COCOA_OPTIONS,
  };
}

const COCOA_OPTIONS: NonNullable<CapacitorOptions["cocoaOptions"]> = {
  tracesSampleRate: 1.0,
  enableAutoPerformanceTracing: true,
  enableUIViewControllerTracing: true,
  enableNetworkTracking: false,
  enableFileIOTracing: false,
  enableCoreDataTracing: false,
  enableUserInteractionTracing: false,
  enableMetricKit: true,
  enableMetricKitRawPayload: false,
  attachAllThreads: true,
  enableSigtermReporting: false,
  enableUnhandledCPPExceptionsV2: false,
  attachScreenshot: false,
  attachViewHierarchy: false,
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
