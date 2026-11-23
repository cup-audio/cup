import type { Breadcrumb, Contexts, ErrorEvent, EventHint } from "@sentry/react";

import { maskBreadcrumbUrls, maskEventUrls } from "@cup/telemetry.core";

const SUPABASE_AUTH_MECHANISM = "auto.db.supabase.auth";

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
