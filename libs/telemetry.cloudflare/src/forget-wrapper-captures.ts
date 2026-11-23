import type { Integration } from "@sentry/core";

import { isWrapperCapture } from "#src/server-before-send.ts";

const SENTRY_CAPTURED_MARKER = "__sentry_captured__";

export function forgetWrapperCapturesIntegration(): Integration {
  return {
    name: "CupForgetWrapperCaptures",
    setup(client) {
      const captureException = client.captureException.bind(client);
      client.captureException = (exception, hint, scope) => {
        if (!isWrapperCapture(hint?.mechanism?.type) && isObject(exception)) {
          Reflect.deleteProperty(exception, SENTRY_CAPTURED_MARKER);
        }
        return captureException(exception, hint, scope);
      };
    },
  };
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
