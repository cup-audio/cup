import { captureException } from "@sentry/core";

/**
 * Runs one pass of a Durable Object alarm and captures the error the pass throws before rethrowing
 * it, so that the platform still retries the alarm. Nothing above the alarm captures it: Sentry's
 * Durable Object wrapper would, but Cup's `beforeSend` drops the wrapper's captures, which it
 * cannot tell apart from those of RPC errors that the caller captures. The error is marked as
 * captured, so the wrapper does not capture it a second time.
 */
export async function captureAlarmFailure(pass: () => Promise<void>): Promise<void> {
  try {
    await pass();
  } catch (error) {
    captureException(error);
    throw error;
  }
}
