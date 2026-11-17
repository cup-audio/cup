import { expect, test } from "vitest";

import {
  parseWebViewProcessLoss,
  webViewProcessLossMessage,
  type WebViewProcessLoss,
} from "#src/webview-process-loss.ts";

test("an Android renderer crash becomes one error grouped by its own fingerprint, with cause, priority and foreground state", () => {
  const loss = parseLoss({
    platform: "android",
    didCrash: true,
    rendererPriorityAtExit: "important",
    inForeground: true,
  });

  expect(webViewProcessLossMessage(loss)).toEqual({
    message: "The WebView's renderer process is gone",
    context: {
      level: "error",
      fingerprint: ["webview-renderer-gone"],
      tags: {
        "cup.renderer.cause": "crash",
        "cup.renderer.priority_at_exit": "important",
        "cup.app.state": "foreground",
      },
    },
  });
});

test("an Android renderer the system killed in the background is a system kill", () => {
  const loss = parseLoss({
    platform: "android",
    didCrash: false,
    rendererPriorityAtExit: "waived",
    inForeground: false,
  });

  expect(webViewProcessLossMessage(loss).context.tags).toEqual({
    "cup.renderer.cause": "system-kill",
    "cup.renderer.priority_at_exit": "waived",
    "cup.app.state": "background",
  });
});

test("an iOS WebContent termination becomes one error grouped by its own fingerprint, with the foreground state", () => {
  const loss = parseLoss({ platform: "ios", inForeground: false });

  expect(webViewProcessLossMessage(loss)).toEqual({
    message: "The WebView's content process terminated",
    context: {
      level: "error",
      fingerprint: ["webview-content-terminated"],
      tags: { "cup.app.state": "background" },
    },
  });
});

test("no loss since the last start is nothing to report", () => {
  expect(parseWebViewProcessLoss(undefined)).toBeUndefined();
});

test("a malformed loss from the native side fails loudly", () => {
  expect(() => parseWebViewProcessLoss({ platform: "android", inForeground: true })).toThrow(
    /malformed WebView process loss/,
  );
  expect(() => parseWebViewProcessLoss({ platform: "web", inForeground: true })).toThrow(
    /malformed WebView process loss/,
  );
});

function parseLoss(value: unknown): WebViewProcessLoss {
  const loss = parseWebViewProcessLoss(value);
  if (loss === undefined) {
    throw new Error("Expected a WebView process loss.");
  }
  return loss;
}
