import { registerPlugin } from "@capacitor/core";

import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

/**
 * The shell's WebView lost its page since the web app last started: on Android, its renderer
 * process is gone; on iOS, its WebContent process terminated. The native side recorded it and
 * brought the page back.
 */
export type WebViewProcessLoss =
  | {
      readonly platform: "android";
      /** Whether the renderer crashed, rather than the system killing it to reclaim memory. */
      readonly didCrash: boolean;
      /** `waived`, `bound` or `important`, by `RenderProcessGoneDetail.rendererPriorityAtExit()`. */
      readonly rendererPriorityAtExit: string;
      readonly isInForeground: boolean;
    }
  | {
      readonly platform: "ios";
      readonly isInForeground: boolean;
    };

/** The JS interface of the shells' `WebViewProcessLoss` plugin. */
type WebViewProcessLossPlugin = {
  /** Returns the loss recorded since the web app last started, if any, and forgets it. */
  takeLoss(): Promise<{ loss?: unknown }>;
};

const webViewProcessLossPlugin = registerPlugin<WebViewProcessLossPlugin>("WebViewProcessLoss");

/**
 * The shell's WebView process loss since the web app last started, if any. Forgets it, so each loss
 * is reported once. Call it only in a native shell.
 */
export async function takeWebViewProcessLoss(): Promise<WebViewProcessLoss | undefined> {
  const { loss } = await webViewProcessLossPlugin.takeLoss();
  return parseWebViewProcessLoss(loss);
}

/**
 * Checks what the native side recorded; `undefined` means no loss.
 *
 * @throws When the value is not a loss either platform records
 */
export function parseWebViewProcessLoss(value: unknown): WebViewProcessLoss | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "object") {
    const platform: unknown = Reflect.get(value, "platform");
    // The native side records the flag as `inForeground`.
    const isInForeground: unknown = Reflect.get(value, "inForeground");
    const didCrash: unknown = Reflect.get(value, "didCrash");
    const rendererPriorityAtExit: unknown = Reflect.get(value, "rendererPriorityAtExit");
    if (
      platform === "android" &&
      typeof isInForeground === "boolean" &&
      typeof didCrash === "boolean" &&
      typeof rendererPriorityAtExit === "string"
    ) {
      return { platform, didCrash, rendererPriorityAtExit, isInForeground };
    }
    if (platform === "ios" && typeof isInForeground === "boolean") {
      return { platform, isInForeground };
    }
  }
  throw new Error(`The shell recorded a malformed WebView process loss: ${JSON.stringify(value)}`);
}

/**
 * The one error event a WebView process loss becomes, for `Sentry.captureMessage(message,
 * context)`. A fixed fingerprint per platform groups every loss into one issue.
 */
export function webViewProcessLossMessage(loss: WebViewProcessLoss): {
  message: string;
  context: { level: "error"; fingerprint: string[]; tags: Record<string, string> };
} {
  const appState = loss.isInForeground ? "foreground" : "background";
  if (loss.platform === "android") {
    return {
      message: "The WebView's renderer process is gone",
      context: {
        level: "error",
        fingerprint: ["webview-renderer-gone"],
        tags: {
          [TELEMETRY_ATTRIBUTES.RENDERER_CAUSE]: loss.didCrash ? "crash" : "system-kill",
          [TELEMETRY_ATTRIBUTES.RENDERER_PRIORITY_AT_EXIT]: loss.rendererPriorityAtExit,
          [TELEMETRY_ATTRIBUTES.APP_STATE]: appState,
        },
      },
    };
  }
  return {
    message: "The WebView's content process terminated",
    context: {
      level: "error",
      fingerprint: ["webview-content-terminated"],
      tags: { [TELEMETRY_ATTRIBUTES.APP_STATE]: appState },
    },
  };
}
