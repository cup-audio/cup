import type { Breadcrumb, Contexts, ErrorEvent, EventHint } from "@sentry/react";

import { maskUrl } from "@cup/telemetry.core";

/**
 * The mechanism of the errors that Sentry's Supabase integration captures from failed auth calls.
 * The web app handles those failures itself, so the integration adds spans and breadcrumbs only.
 */
const SUPABASE_AUTH_MECHANISM = "auto.db.supabase.auth";

/**
 * The client's `beforeSend`: only the opaque user ID, no IP address, no device identifiers, masked
 * URLs, and no Supabase auth errors. The device identifiers are those a native SDK copies onto JS
 * events through scope sync; the organisation's scrubbing rule removes them again at ingest.
 */
export function beforeSendClientEvent(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  if (isSupabaseAuthError(event)) {
    return null;
  }

  const userId = event.user?.id;
  const sent: ErrorEvent = {
    ...event,
    user: { ...(userId === undefined ? {} : { id: userId }), ip_address: null },
  };

  if (event.message !== undefined) {
    sent.message = maskUrl(event.message);
  }

  if (event.request !== undefined) {
    const { url, query_string: queryString } = event.request;
    sent.request = {
      ...event.request,
      ...(url === undefined ? {} : { url: maskUrl(url) }),
      ...(typeof queryString === "string" ? { query_string: maskUrl(queryString) } : {}),
    };
  }

  if (event.exception?.values !== undefined) {
    sent.exception = {
      ...event.exception,
      values: event.exception.values.map((value) =>
        value.value === undefined ? value : { ...value, value: maskUrl(value.value) },
      ),
    };
  }

  if (event.breadcrumbs !== undefined) {
    sent.breadcrumbs = event.breadcrumbs.map(beforeBreadcrumbClient);
  }

  if (event.contexts !== undefined) {
    sent.contexts = withoutDeviceIdentifiers(event.contexts);
  }

  return sent;
}

/**
 * The client's `beforeBreadcrumb`: masks URLs in the message and in every string of its data, such
 * as a request's `url` or a navigation's `from` and `to`. Scope sync copies breadcrumbs onto native
 * events, which no `beforeSend` of Cup's sees.
 */
export function beforeBreadcrumbClient(breadcrumb: Breadcrumb): Breadcrumb {
  return {
    ...breadcrumb,
    ...(breadcrumb.message === undefined ? {} : { message: maskUrl(breadcrumb.message) }),
    ...(breadcrumb.data === undefined
      ? {}
      : {
          data: Object.fromEntries(
            Object.entries(breadcrumb.data).map(([key, value]) => [
              key,
              typeof value === "string" ? maskUrl(value) : value,
            ]),
          ),
        }),
  };
}

function isSupabaseAuthError(event: ErrorEvent): boolean {
  return (
    event.exception?.values?.some(
      (exception) => exception.mechanism?.type === SUPABASE_AUTH_MECHANISM,
    ) ?? false
  );
}

function withoutDeviceIdentifiers(contexts: Contexts): Contexts {
  const { device, app, ...otherContexts } = contexts;
  const scrubbed: Contexts = otherContexts;
  if (device !== undefined) {
    const { id: _deviceId, ...deviceContext } = device;
    scrubbed.device = deviceContext;
  }
  if (app !== undefined) {
    const { device_app_hash: _deviceAppHash, ...appContext } = app;
    scrubbed.app = appContext;
  }
  return scrubbed;
}
