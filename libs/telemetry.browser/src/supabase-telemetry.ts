import { supabaseIntegration, type addIntegration } from "@sentry/react";

/**
 * Sentry's Supabase integration for the web app's Supabase client, which exists only once account
 * auth loads its configuration; add it then with `Sentry.addIntegration`. It sends no query data,
 * and the client `beforeSend` drops the auth errors it captures, so it adds spans and breadcrumbs
 * only.
 */
export function clientSupabaseIntegration(
  supabaseClient: unknown,
): Parameters<typeof addIntegration>[0] {
  return supabaseIntegration({ supabaseClient, sendOperationData: false });
}
