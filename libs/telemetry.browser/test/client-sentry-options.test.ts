import {
  BrowserClient,
  defaultStackParser,
  eventFiltersIntegration,
  makeFetchTransport,
  type ErrorEvent,
} from "@sentry/react";
import { expect, test } from "vitest";

import { CUP_APP_DSN } from "@cup/telemetry.core";

import { createClientSentryOptions } from "#src/client-sentry-options.ts";

const ROUTER = { subscribe: () => () => undefined };

test("the browser sends to cup-app through the tunnel on https://cup.audio", () => {
  const options = createClientSentryOptions({
    pageOrigin: "https://cup.audio",
    apiOrigin: "https://cup.audio",
    release: "web@0123456789abcdef",
    router: ROUTER,
  });

  expect(options?.dsn).toBe(CUP_APP_DSN);
  expect(options?.tunnel).toBe("https://cup.audio/_/e");
  expect(options?.release).toBe("web@0123456789abcdef");
});

test.each([
  "http://cup.audio",
  "https://www.cup.audio",
  "https://cup.audio.example",
  "https://localhost:8443",
  "http://127.0.0.1:5173",
  "capacitor://localhost",
  "null",
])("the browser sends nothing on %s", (pageOrigin) => {
  expect(
    createClientSentryOptions({
      pageOrigin,
      apiOrigin: pageOrigin,
      release: undefined,
      router: ROUTER,
    }),
  ).toBeUndefined();
});

const APP_INFO = { version: "1.4.0", build: "17" };

test("a release shell sends to cup-app through the tunnel when its API origin is https://cup.audio, as its app version", () => {
  const options = createClientSentryOptions({
    pageOrigin: "https://localhost",
    apiOrigin: "https://cup.audio",
    release: "web@0123456789abcdef",
    router: ROUTER,
    shell: {
      isDebugBuild: false,
      testSentryDsn: undefined,
      shouldSendCrashReports: true,
      app: APP_INFO,
    },
  });

  expect(options).toMatchObject({
    dsn: CUP_APP_DSN,
    tunnel: "https://cup.audio/_/e",
    release: "audio.cup.app@1.4.0+17",
    dist: "17",
    enableNative: true,
    initialScope: { tags: { "cup.web_release": "web@0123456789abcdef" } },
  });
});

test.each(["http://localhost:8787", "https://www.cup.audio", "http://cup.audio"])(
  "a release shell sends nothing against the API origin %s",
  (apiOrigin) => {
    expect(
      createClientSentryOptions({
        pageOrigin: "https://localhost",
        apiOrigin,
        release: "web@0123456789abcdef",
        router: ROUTER,
        shell: {
          isDebugBuild: false,
          testSentryDsn: undefined,
          shouldSendCrashReports: true,
          app: APP_INFO,
        },
      }),
    ).toBeUndefined();
  },
);

test.each(["https://cup.audio", "http://localhost:8787"])(
  "a debug shell without a test DSN sends nothing against %s",
  (apiOrigin) => {
    expect(
      createClientSentryOptions({
        pageOrigin: "https://localhost",
        apiOrigin,
        release: "web@0123456789abcdef",
        router: ROUTER,
        shell: {
          isDebugBuild: true,
          testSentryDsn: undefined,
          shouldSendCrashReports: true,
          app: APP_INFO,
        },
      }),
    ).toBeUndefined();
  },
);

test("a debug shell with a test DSN sends only to it, through the test Worker's tunnel", () => {
  const testSentryDsn = "http://public@127.0.0.1:51234/2";
  const options = createClientSentryOptions({
    pageOrigin: "https://localhost",
    apiOrigin: "http://localhost:8787",
    release: "web@0123456789abcdef",
    router: ROUTER,
    shell: { isDebugBuild: true, testSentryDsn, shouldSendCrashReports: true, app: APP_INFO },
  });

  expect(options).toMatchObject({
    dsn: testSentryDsn,
    tunnel: "http://localhost:8787/_/e",
    release: "audio.cup.app@1.4.0+17",
  });
});

test("a shell whose listener turned crash reports off runs JS-only, still sending JS errors", () => {
  const options = createClientSentryOptions({
    pageOrigin: "https://localhost",
    apiOrigin: "https://cup.audio",
    release: "web@0123456789abcdef",
    router: ROUTER,
    shell: {
      isDebugBuild: false,
      testSentryDsn: undefined,
      shouldSendCrashReports: false,
      app: APP_INFO,
    },
  });

  expect(options).toMatchObject({
    dsn: CUP_APP_DSN,
    tunnel: "https://cup.audio/_/e",
    release: "audio.cup.app@1.4.0+17",
    enableNative: false,
  });
});

test("a shell gives the Cocoa SDK native tracing of view controllers and frames only, and its MetricKit reports", () => {
  const options = createClientSentryOptions({
    pageOrigin: "capacitor://localhost",
    apiOrigin: "https://cup.audio",
    release: "web@0123456789abcdef",
    router: ROUTER,
    shell: {
      isDebugBuild: false,
      testSentryDsn: undefined,
      shouldSendCrashReports: true,
      app: APP_INFO,
    },
  });

  expect(options?.cocoaOptions).toStrictEqual({
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
  });
  // App-hang tracking stays at Cocoa's defaults.
  expect(options).not.toHaveProperty("enableAppHangTracking");
  expect(options).not.toHaveProperty("appHangTimeoutInterval");
});

test("the browser passes no Cocoa options", () => {
  const options = createClientSentryOptions({
    pageOrigin: "https://cup.audio",
    apiOrigin: "https://cup.audio",
    release: "web@0123456789abcdef",
    router: ROUTER,
  });

  expect(options).not.toHaveProperty("cocoaOptions");
});

/** Whether Sentry's event filters drop an error event of this type and message under the options. */
function isIgnored(type: string, value: string): boolean {
  const options = createClientSentryOptions({
    pageOrigin: "https://cup.audio",
    apiOrigin: "https://cup.audio",
    release: "web@0123456789abcdef",
    router: ROUTER,
  });
  const event: ErrorEvent = { type: undefined, exception: { values: [{ type, value }] } };
  // A client that sends nothing, only to hand the options to Sentry's event filters.
  const client = new BrowserClient({
    ...(options?.ignoreErrors === undefined ? {} : { ignoreErrors: options.ignoreErrors }),
    integrations: [],
    stackParser: defaultStackParser,
    transport: makeFetchTransport,
  });
  return eventFiltersIntegration().processEvent?.(event, {}, client) === null;
}

test.each([
  ["AbortError", "The user aborted a request."],
  ["AbortError", "The operation was aborted."],
  ["Error", "ResizeObserver loop completed with undelivered notifications."],
])("ignores the browser noise %s: %s", (type, value) => {
  expect(isIgnored(type, value)).toBe(true);
});

test.each([
  ["TypeError", "Failed to fetch"],
  ["TypeError", "Load failed"],
  ["TypeError", "NetworkError when attempting to fetch resource."],
  ["Error", "Saving the AbortError handling state failed"],
])("keeps the failed request or other error %s: %s", (type, value) => {
  expect(isIgnored(type, value)).toBe(false);
});
