import { expect } from "vitest";

import type { TestWorker } from "@cup/test-worker";

import { pathname, waitForRecents } from "#src/journeys.ts";

const CONVERSION_START_TIMEOUT_MS = 30_000;

export async function waitForSharedConversions(
  webView: WebdriverIO.Browser,
  worker: TestWorker,
  { requestCount, starts, tracks }: { requestCount: number; starts: number; tracks: number },
): Promise<string[]> {
  await webView.waitUntil(() => conversionStartsSince(worker, requestCount).length >= starts, {
    timeout: CONVERSION_START_TIMEOUT_MS,
    timeoutMsg: `The shares did not start ${starts} conversion(s).`,
  });
  await webView.waitUntil(async () => !(await webView.$('[role="dialog"]').isExisting()), {
    timeout: 10_000,
    timeoutMsg: "The Add dialog stayed open after its start.",
  });
  await waitForRecents(webView, tracks);
  return conversionStartsSince(worker, requestCount);
}

export async function expectSignInForStartFormUrl(
  webView: WebdriverIO.Browser,
  url: string,
): Promise<void> {
  await webView.$("button=Continue with Google").waitForDisplayed({ timeout: 30_000 });
  expect(await pathname(webView)).toBe("/app/");
  await expect
    .poll(() => webView.$('input[type="url"]').getValue(), { timeout: 10_000, interval: 250 })
    .toBe(url);
}

export function conversionStartsSince(worker: TestWorker, count: number): string[] {
  return worker
    .requests()
    .slice(count)
    .filter(({ method, path }) => method === "POST" && /\/conversions(?:\?|$)/u.test(path))
    .map(({ body }) => readSourceUrl(body));
}

function readSourceUrl(body: string | undefined): string {
  const parsed: unknown = JSON.parse(body ?? "null");
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("sourceUrl" in parsed) ||
    typeof parsed.sourceUrl !== "string"
  ) {
    throw new TypeError(`A conversion start carried no source URL: ${body}`);
  }
  return parsed.sourceUrl;
}
