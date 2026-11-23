import { registerPlugin } from "@capacitor/core";

import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

export type WebViewProcessLoss =
  | {
      readonly platform: "android";
      readonly didCrash: boolean;
      readonly rendererPriorityAtExit: string;
      readonly isInForeground: boolean;
    }
  | {
      readonly platform: "ios";
      readonly isInForeground: boolean;
    };

type WebViewProcessLossPlugin = {
  takeLoss(): Promise<{ loss?: unknown }>;
};

const webViewProcessLossPlugin = registerPlugin<WebViewProcessLossPlugin>("WebViewProcessLoss");

export async function takeWebViewProcessLoss(): Promise<WebViewProcessLoss | undefined> {
  const { loss } = await webViewProcessLossPlugin.takeLoss();
  return parseWebViewProcessLoss(loss);
}

export function parseWebViewProcessLoss(value: unknown): WebViewProcessLoss | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "object") {
    const platform: unknown = Reflect.get(value, "platform");
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
