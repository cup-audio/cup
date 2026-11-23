import * as Sentry from "@sentry/react";

export function reportFailure(message: string) {
  return (error: unknown) => {
    Sentry.captureException(new Error(message, { cause: error }));
  };
}
