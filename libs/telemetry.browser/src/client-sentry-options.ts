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

/** Where the client runs, which decides whether it sends, and what it reports as. */
export type ClientTelemetryContext = {
  /** `window.location.origin`. */
  pageOrigin: string;
  /** The origin of the Listener API and the telemetry tunnel. */
  apiOrigin: string;
  /** From `readWebRelease`; `undefined` under Vite's development server. */
  release: string | undefined;
  /** The app's TanStack Router, which names page-load and navigation spans after its routes. */
  router: object;
  /** Set only in a native shell, whose on/off rule and release differ from the browser's. */
  shell?: ShellTelemetryContext;
};

/** What a native shell tells the web app about itself before Sentry starts. */
export type ShellTelemetryContext = {
  /**
   * Whether the shell is a debug build, as its native side says. Callers count only an explicit
   * "release" as one, so a shell that says nothing is a debug build and sends nothing.
   */
  isDebugBuild: boolean;
  /**
   * Debug builds only: the DSN the mobile E2E suite passed as the `cupTestSentryDsn` launch
   * argument, the Sentry stub's.
   */
  testSentryDsn: string | undefined;
  /**
   * The shell's "Send crash reports" switch, which the native `CrashReporting` plugin keeps. Off,
   * the shell runs JS-only: its JS errors still go through the tunnel, but the native SDK stays
   * off.
   */
  shouldSendCrashReports: boolean;
  /** The app's version and build number, from `App.getInfo()`. */
  app: { version: string; build: string };
};

/**
 * The only origin the browser sends from, and the only API origin a release shell sends against:
 * every E2E suite runs the production bundle elsewhere.
 */
const PRODUCTION_ORIGIN = "https://cup.audio";

/** The shells' application ID, which names their release. */
const SHELL_APP_ID = "audio.cup.app";

/**
 * Known browser noise: a layout loop the browser recovers from itself, and a request aborted on
 * navigation, which rejects with an `AbortError`. Sentry matches a string anywhere in the message,
 * so each pattern is an anchored regular expression. A request that fails for another reason, such
 * as a dropped connection, is still captured when nothing handles it.
 */
const IGNORED_ERRORS = [/^ResizeObserver loop/, /^AbortError: /];

/**
 * Sentry's options for the web app, or `undefined` when it must send nothing. By the on/off rule:
 *
 * - The browser sends only from `https://cup.audio`;
 * - A release shell sends only when its API origin is `https://cup.audio`;
 * - A debug shell sends nothing, unless the mobile E2E suite passed it a test DSN, and then only to
 *   that DSN.
 */
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
    // Through Cup's own domain, so ad blockers that block Sentry's hosts don't drop it.
    transport: makeFetchTransport,
    tunnel: `${apiOrigin}${TELEMETRY_TUNNEL_PATH}`,
    // `dataCollection` stays unset: setting any of its keys makes the others permissive.
    sendDefaultPii: false,
    enableLogs: true,
    beforeSendLog,
    /*
     * A sampler, not `tracesSampleRate`: the Capacitor SDK bridges a sample rate to the Cocoa SDK,
     * which would turn on all of its automatic tracing.
     */
    tracesSampler: () => 1.0,
    traceLifecycle: "stream",
    // Requests to the Listener API join the Worker's trace; no other host gets trace headers.
    tracePropagationTargets: [new RegExp(`^${escapeRegExp(apiOrigin)}/`)],
    propagateTraceparent: false,
    strictTraceContinuation: false,
    /*
     * Added to the Capacitor SDK's defaults. Zod errors, console capture, feedback, view hierarchy,
     * profiling, CapacitorHttp tracing and replay are not among those and stay off.
     */
    integrations: [
      // The browser SDK streams spans only with this integration.
      spanStreamingIntegration(),
      tanstackRouterBrowserTracingIntegration(router, {
        enableLongAnimationFrame: true,
        // Session-scoped trace linking, not a telemetry identifier; the privacy policy names it.
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

/** Where and as what the client sends: the options that differ between the browser and a shell. */
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
    // The native SDK gets the same release, so a native crash and the JS error before it line up.
    release: `${SHELL_APP_ID}@${app.version}+${app.build}`,
    dist: app.build,
    environment: isDebugBuild ? "debug" : "production",
    ...(webRelease === undefined
      ? {}
      : { initialScope: { tags: { [TELEMETRY_ATTRIBUTES.WEB_RELEASE]: webRelease } } }),
    // Native crashes, ANRs and app hangs, with the native installation ID kept in memory only, unless
    // the listener turned crash reports off. That gives up native release health, so native session
    // tracking is off.
    enableNative: shouldSendCrashReports,
    enableAutoSessionTracking: false,
    enableWatchdogTerminationTracking: false,
    attachThreads: true,
    cocoaOptions: COCOA_OPTIONS,
  };
}

/**
 * What the iOS shell's Cocoa SDK records besides crashes, through the workspace's patch of
 * `@sentry/capacitor`; Android sets the same in its manifest. App-hang tracking and network
 * breadcrumbs keep Cocoa's defaults, both on.
 */
const COCOA_OPTIONS: NonNullable<CapacitorOptions["cocoaOptions"]> = {
  // Native spans of view controllers, with frames tracking, which automatic performance tracing
  // carries; no network, file, Core Data or user-interaction spans.
  tracesSampleRate: 1.0,
  enableAutoPerformanceTracing: true,
  enableUIViewControllerTracing: true,
  enableNetworkTracking: false,
  enableFileIOTracing: false,
  enableCoreDataTracing: false,
  enableUserInteractionTracing: false,
  // Cocoa's crash handler reports uncaught NSExceptions on iOS; its option of that name is macOS's.
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
