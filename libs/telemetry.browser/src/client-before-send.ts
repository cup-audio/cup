import type { Breadcrumb, Contexts, ErrorEvent, EventHint } from "@sentry/react";

import { maskBreadcrumbUrls, maskEventUrls } from "@cup/telemetry.core";

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
    ...maskEventUrls(event),
    user: { ...(userId === undefined ? {} : { id: userId }), ip_address: null },
  };

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
  return maskBreadcrumbUrls(breadcrumb);
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
