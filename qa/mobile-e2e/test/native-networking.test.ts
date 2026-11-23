import { expect, test } from "vitest";

import { useMobileApp } from "#src/fixtures.ts";
import { SOURCE_URL, signInFromLandingPage, waitForRecents } from "#src/journeys.ts";

const app = useMobileApp();

test("a conversion started from the Add dialog reaches the Worker through native networking", async () => {
  await app.device.launch({ apiOrigin: app.apiOrigin });
  const webView = await app.device.webView();
  await signInFromLandingPage(app.device, webView);
  await webView.$('a[aria-label="Back"]').click();
  await waitForRecents(webView, 1);

  const requestCount = app.worker.requests().length;
  await webView.$('nav[aria-label="Tabs"]').$("a*=Add").click();
  const addDialog = webView.$('[role="dialog"]');
  await webView.waitUntil(
    () =>
      webView.execute(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return (
          dialog !== null &&
          dialog
            .getAnimations({ subtree: true })
            .every((animation) => animation.playState === "finished")
        );
      }),
    { timeout: 10_000, timeoutMsg: "The Add sheet did not finish sliding in." },
  );
  await addDialog.$('input[type="url"]').setValue(SOURCE_URL);
  await addDialog.$("button=Add").click();
  await addDialog.waitForExist({ reverse: true, timeout: 60_000 });

  await waitForRecents(webView, 2);
  const requests = app.worker.requests().slice(requestCount);
  const mutations = requests.filter(
    ({ method, path }) => method === "POST" && path === "/api/account/conversions",
  );
  expect(mutations).toHaveLength(1);
  const [mutation] = mutations;
  expect(mutation?.headers).not.toHaveProperty("origin");
  expect(mutation?.headers).toMatchObject({
    "content-type": "application/json",
    "x-create-audiobook-from-url-request": "1",
  });
  const accountRequests = requests.filter(({ path }) => path.startsWith("/api/account/"));
  expect(accountRequests).toContainEqual(expect.objectContaining({ method: "GET" }));
  for (const { headers } of accountRequests) {
    expect(bearerTokenClaims(headers["authorization"])).toMatchObject({
      iss: `${app.authProvider.origin}/auth/v1`,
      role: "authenticated",
    });
  }
});

function bearerTokenClaims(authorization: string | undefined): unknown {
  const payload = /^Bearer [^.\s]+\.([^.\s]+)\.[^.\s]+$/u.exec(authorization ?? "")?.[1];
  if (payload === undefined) {
    throw new Error(`The request carried no bearer token: ${String(authorization)}`);
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}
