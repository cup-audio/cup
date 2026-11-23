import type { AppDevice } from "#src/app-device.ts";

export const SOURCE_URL = "https://source.example.test/fixture";

const SIGN_IN_TIMEOUT_MS = 60_000;

export async function signInFromLandingPage(
  device: AppDevice,
  webView: WebdriverIO.Browser,
): Promise<void> {
  await startSignInFromLandingPage(webView);
  await webView.$("button=Continue with Google").click();
  await device.continueGoogleSignIn();
  await webView.waitUntil(async () => (await pathname(webView)).startsWith("/app/audiobooks/"), {
    timeout: SIGN_IN_TIMEOUT_MS,
    timeoutMsg: "Signing in did not open the new audiobook.",
  });
}

export async function signInFromHomeLink(
  device: AppDevice,
  webView: WebdriverIO.Browser,
): Promise<void> {
  const link = webView.$("a=Sign in");
  await link.waitForDisplayed({ timeout: 30_000 });
  await link.click();
  const signIn = webView.$("button=Continue with Google");
  await signIn.waitForEnabled({ timeout: 30_000 });
  await signIn.click();
  await device.continueGoogleSignIn();
  await webView.waitUntil(async () => (await pathname(webView)) === "/app/recent", {
    timeout: SIGN_IN_TIMEOUT_MS,
    timeoutMsg: "Signing in from the home link did not land on Recents.",
  });
}

export async function startSignInFromLandingPage(webView: WebdriverIO.Browser): Promise<void> {
  const url = webView.$('input[type="url"]');
  await url.waitForDisplayed({ timeout: 30_000 });
  await url.setValue(SOURCE_URL);
  await webView.$("button=Listen").click();
  await webView.$("button=Continue with Google").waitForEnabled({ timeout: 30_000 });
}

export async function waitForRecents(webView: WebdriverIO.Browser, count: number): Promise<void> {
  await webView.waitUntil(
    async () =>
      (await pathname(webView)) === "/app/recent" &&
      (await webView.$$('ul[aria-label="Tracks"] > li').length) === count,
    { timeout: 30_000, timeoutMsg: `Recents did not list ${count} track(s).` },
  );
}

export async function waitForLandingPage(webView: WebdriverIO.Browser): Promise<void> {
  await webView.$("button=Listen").waitForDisplayed({ timeout: 30_000 });
  await webView.waitUntil(async () => (await pathname(webView)) === "/app/", {
    timeout: 10_000,
    timeoutMsg: "The landing page is not at /app/.",
  });
}

export const NARRATION_LINK_URL = "https://source.example.test/deterministic-fakes";

export async function openNarrationLink(webView: WebdriverIO.Browser): Promise<void> {
  const link = webView.$(`article a[href="${NARRATION_LINK_URL}"]`);
  await link.waitForExist({ timeout: 60_000 });
  await link.scrollIntoView({ block: "center" });
  await webView.execute(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await link.click();
  const popover = webView.$('a[aria-label^="Open link"]');
  await popover.waitForDisplayed({ timeout: 10_000 });
  await popover.click();
}

export async function openOriginalPage(webView: WebdriverIO.Browser): Promise<void> {
  await webView.$('button[aria-label="More"]').click();
  const openOriginal = webView.$("a=Open original page");
  await openOriginal.waitForDisplayed({ timeout: 10_000 });
  await openOriginal.click();
}

export function pathname(webView: WebdriverIO.Browser): Promise<string> {
  return webView.execute(() => window.location.pathname);
}
