import type { Integration } from "@sentry/core";

import { isWrapperCapture } from "#src/server-before-send.ts";

/** The property Sentry sets on every error it captures; it never captures a marked error again. */
const SENTRY_CAPTURED_MARKER = "__sentry_captured__";

/**
 * Lets each of Cup's own captures reach Sentry even when one of Sentry's wrappers captured the
 * error first, an event the Worker's `beforeSend` drops. The Durable Object wrapper marks the error
 * an RPC method throws, and the RPC call copies the mark onto the error its caller receives, such
 * as the API server or a Workflow step; the Workflow wrapper marks the error of a step's last
 * failed attempt, which the run captures again. Sentry skips a marked error without a word, so
 * every capture that is not a wrapper's clears the mark first; Cup's capture rule already captures
 * each failure once.
 */
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
