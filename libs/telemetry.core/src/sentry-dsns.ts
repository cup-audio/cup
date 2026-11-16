/*
 * The public DSNs of Cup's two Sentry projects, copied once from the Terraform outputs
 * `cup_worker_dsn` and `cup_app_dsn` of `terraform/sentry`. A DSN is public by design: it only lets
 * a client send events to its project. Only production configuration uses these; local development
 * and tests run with an empty DSN or one that points at the Sentry stub.
 */

/** The `cup-worker` project: the Worker's fetch handler, Durable Objects and Workflows. */
export const CUP_WORKER_DSN =
  "https://aa6ceda71485efec30877677d4eb919b@o4512441473040384.ingest.de.sentry.io/4512441485623377";

/** The `cup-app` project: the web app and both Capacitor shells. */
export const CUP_APP_DSN =
  "https://4675dd0e4efd764f8941a9a0482a044d@o4512441473040384.ingest.de.sentry.io/4512441485623376";
