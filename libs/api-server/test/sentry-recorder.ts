import {
  createStackParser,
  createTransport,
  getCurrentScope,
  resolvedSyncPromise,
  type ErrorEvent,
} from "@sentry/core";
import { ServerRuntimeClient } from "@sentry/core/server";

export type RecordedLog = {
  event: unknown;
  message: unknown;
  attributes: Record<string, unknown>;
};

export type SentryRecorder = { exceptions: unknown[]; events: ErrorEvent[]; logs: RecordedLog[] };

export function recordSentry(): SentryRecorder {
  const recorder: SentryRecorder = { exceptions: [], events: [], logs: [] };
  const client = new ServerRuntimeClient({
    dsn: "https://public@sentry.example.test/1",
    integrations: [],
    stackParser: createStackParser(),
    transport: (options) => createTransport(options, () => resolvedSyncPromise({})),
    beforeSend: (event, hint) => {
      recorder.exceptions.push(hint.originalException);
      recorder.events.push(event);
      return null;
    },
    beforeSendLog: (log) => {
      const { "event.name": event, ...attributes } = Object.fromEntries(
        Object.entries(log.attributes ?? {}).filter(([key]) => !key.startsWith("sentry.")),
      );
      recorder.logs.push({ event, message: log.message, attributes });
      return null;
    },
  });
  getCurrentScope().setClient(client);
  client.init();
  return recorder;
}

export function stopRecordingSentry() {
  getCurrentScope().setClient(undefined);
}
