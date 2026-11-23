import { supabaseIntegration, type addIntegration } from "@sentry/react";

export function clientSupabaseIntegration(
  supabaseClient: unknown,
): Parameters<typeof addIntegration>[0] {
  return supabaseIntegration({ supabaseClient, sendOperationData: false });
}
