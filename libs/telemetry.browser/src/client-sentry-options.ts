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

import { beforeSendLog, CUP_APP_DSN, maskSpanUrls } from "@cup/telemetry.core";

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
};

/** The only origin the browser sends from: every E2E suite runs the production bundle elsewhere. */
const PRODUCTION_ORIGIN = "https://cup.audio";

/** The telemetry tunnel on the Worker, at the API origin. */
const TUNNEL_PATH = "/_/e";

/**
 * Known browser noise: a layout loop the browser recovers from itself, and requests the browser
 * aborts when the page navigates away or the connection drops. A failed request is a breadcrumb;
 * the Worker has already captured a server failure.
 */
const IGNORED_ERRORS = [
  /^ResizeObserver loop/,
  "AbortError",
  "The user aborted a request.",
  "The operation was aborted.",
  "Failed to fetch",
  "Load failed",
  "NetworkError when attempting to fetch resource.",
];

/**
 * Sentry's options for the web app, or `undefined` when it must send nothing. By the on/off rule,
 * the browser sends only from `https://cup.audio`; every other origin, the shells' included, sends
 * nothing.
 */
export function createClientSentryOptions({
  pageOrigin,
  apiOrigin,
  release,
  router,
}: ClientTelemetryContext): CapacitorOptions | undefined {
  if (pageOrigin !== PRODUCTION_ORIGIN) {
    return undefined;
  }

  return {
    dsn: CUP_APP_DSN,
    ...(release === undefined ? {} : { release }),
    environment: "production",
    // Through Cup's own domain, so ad blockers that block Sentry's hosts don't drop it.
    transport: makeFetchTransport,
    tunnel: `${apiOrigin}${TUNNEL_PATH}`,
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
