import { captureException } from "@sentry/core";

export async function captureAlarmFailure(pass: () => Promise<void>): Promise<void> {
  try {
    await pass();
  } catch (error) {
    captureException(error);
    throw error;
  }
}
