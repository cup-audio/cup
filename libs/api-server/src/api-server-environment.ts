import type { AccountDurableObject } from "@cup/accounts";
import type { SegmentWorkflowParams } from "@cup/conversion-contracts";
import type { ConversionParams } from "@cup/conversion-contracts";
import type { ConversionGrantDurableObject } from "@cup/conversion-grants";
import type { RegistryDurableObject } from "@cup/registry";

export type ApiServerEnvironment = {
  LOCAL_DEVELOPMENT: string;
  /** Local development only; read through `localTestAccount`. */
  LOCAL_TEST_ACCOUNT_EMAIL?: string;
  LOCAL_TEST_ACCOUNT_PASSWORD?: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  /** Empty only in local development without a Google client, which disables Google sign-in. */
  GOOGLE_WEB_CLIENT_ID: string;
  SUPABASE_URL: string;
  /**
   * The account allowlist: the email addresses, comma-separated, whose sign-in identities may use
   * an account. A secret, because the repository is public; empty refuses every identity.
   */
  ACCOUNT_ALLOWLIST: string;
  SUPABASE_SECRET_KEY: string;
  // Signs the stateless tokens of signed media URLs; rotating it invalidates every outstanding URL.
  MEDIA_URL_SIGNING_KEY: string;
  /**
   * The DSNs the telemetry tunnel forwards to, comma-separated: `cup-app` in production, empty
   * elsewhere.
   */
  SENTRY_TUNNEL_DSNS: string;
  /**
   * Local development only, read with `LOCAL_DEVELOPMENT=true`: signed media and position URLs
   * expire this many seconds after they are handed out, so the mobile E2E suite sees them expire.
   */
  LOCAL_SIGNED_URL_LIFETIME_SECONDS?: string;
  ACCOUNTS: DurableObjectNamespace<AccountDurableObject>;
  REGISTRY: DurableObjectNamespace<RegistryDurableObject>;
  PREPARE_AUDIOBOOK_WORKFLOW: Workflow<ConversionParams>;
  SYNTHESIZE_AUDIO_SEGMENT_WORKFLOW: Workflow<SegmentWorkflowParams>;
  ASSETS: Fetcher;
  AUDIO_BUCKET: R2Bucket;
  CONVERSION_GRANTS: DurableObjectNamespace<ConversionGrantDurableObject>;
  OPERATOR_ACCESS_ISSUER: string;
  OPERATOR_ACCESS_AUDIENCE: string;
  OPERATOR_EMAIL: string;
};
