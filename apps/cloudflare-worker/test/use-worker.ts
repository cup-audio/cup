import nodeUrl from "node:url";
import type { TestContext } from "vitest";
import { createTestHarness, type WorkerHandle } from "wrangler";

import type { ApiServerEnvironment } from "@cup/api-server";

import type * as testWorkerModule from "#test/worker.ts";

export type TestWorker = WorkerHandle<ApiServerEnvironment, typeof testWorkerModule>;

type UseWorkerOptions = Pick<TestContext, "onTestFinished"> & {
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  sentryDsn?: string;
};

const PACKAGE_DIRECTORY = nodeUrl.fileURLToPath(new URL("..", import.meta.url));

export const TEST_SECRETS = {
  CLOUDFLARE_API_KEY: "test-cloudflare-api-key",
  SOURCE_PAGE_COOKIES_JSON: "[]",
  SUPABASE_SECRET_KEY: "test-supabase-secret-key",
  SUPABASE_PUBLISHABLE_KEY: "test-supabase-publishable-key",
  GOOGLE_WEB_CLIENT_ID: "test-google-web-client-id",
  RESEND_API_KEY: "test-resend-api-key",
  MEDIA_URL_SIGNING_KEY: "test-media-url-signing-key",
  APPLE_SIGN_IN_KEY: "test-apple-sign-in-key",
} as const;

export async function useWorker({
  onTestFinished,
  vars = {},
  secrets = {},
  sentryDsn,
}: UseWorkerOptions): Promise<TestWorker> {
  const testRuntime = createTestHarness({
    root: PACKAGE_DIRECTORY,
    workers: [
      {
        configPath: "./test/wrangler.test.jsonc",
        vars: sentryDsn === undefined ? vars : { ...vars, SENTRY_DSN: sentryDsn },
        secrets: { ...TEST_SECRETS, ...secrets },
      },
    ],
  });
  onTestFinished(() => testRuntime.close());

  await testRuntime.listen();

  return testRuntime.getWorker<ApiServerEnvironment, typeof testWorkerModule>();
}
