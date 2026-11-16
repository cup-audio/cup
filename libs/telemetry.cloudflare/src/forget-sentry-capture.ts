/** The property Sentry sets on every error it captures; it never captures a marked error again. */
const SENTRY_CAPTURED_MARKER = "__sentry_captured__";

/**
 * Lets Sentry capture an error again that one of its own wrappers already captured, an event the
 * Worker's `beforeSend` drops (`server-before-send.ts`). The Durable Object wrapper marks the error
 * an RPC method throws, and the RPC call copies the mark onto the error its caller receives; the
 * Workflow wrapper marks the error of a step's last failed attempt. Without this, the capture Cup
 * makes at its own boundary, the one that reaches Sentry, would be skipped.
 */
export function forgetSentryCapture(error: unknown): void {
  if (typeof error === "object" && error !== null) {
    Reflect.deleteProperty(error, SENTRY_CAPTURED_MARKER);
  }
}
