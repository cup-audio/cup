import * as Sentry from "@sentry/react";

/**
 * A `.catch` handler for a failure the app carries on after: captures the rejection as the cause of
 * an error whose `message` says what failed, so it stays observable.
 */
export function reportFailure(message: string) {
  return (error: unknown) => {
    Sentry.captureException(new Error(message, { cause: error }));
  };
}
