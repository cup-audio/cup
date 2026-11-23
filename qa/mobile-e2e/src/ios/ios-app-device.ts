import type { AppDevice, LaunchArguments } from "#src/app-device.ts";
import { openAppiumSession, toAppiumAppState, type AppiumAppState } from "#src/appium.ts";
import { appiumFailureArtifacts, type FailureArtifact } from "#src/failure-artifacts.ts";
import { reservePort, run, waitFor } from "#src/host.ts";
import { startLoopbackRelay, type LoopbackRelay } from "#src/ios/loopback-relay.ts";
import { SHARED_PAGE_HEADING } from "#src/ios/shared-page.ts";

export type IosTarget = {
  readonly udid: string;
  readonly platformVersion: string;
  readonly appiumPort: number;
  readonly appPath: string;
  readonly webDriverAgentDerivedData: string;
};

const BUNDLE_ID = "audio.cup.app";
const SAFARI_BUNDLE_ID = "com.apple.mobilesafari";
const API_ORIGIN_KEY = "cupTestApiOrigin";
const SENTRY_DSN_KEY = "cupTestSentryDsn";
const CANCEL_APPLE_SIGN_IN_KEY = "cupTestCancelAppleSignIn";

export type IosLaunchArguments = LaunchArguments & {
  readonly cancelAppleSignIn?: boolean;
};
const DEVICE_LOG_PREDICATE = [
  'process == "App"',
  'process == "CupShare"',
  'process BEGINSWITH "com.apple.WebKit"',
  'process == "MobileSafari"',
].join(" OR ");
const CUP_PAGE_ORIGIN = "capacitor://localhost";

export type ShareApp = "cup" | "safari";

const SHARE_SHEET = {
  more: 'type == "XCUIElementTypeButton" AND (label == "More" OR name CONTAINS "More")',
  share: 'type == "XCUIElementTypeButton" AND label == "Share"',
  cup: 'type == "XCUIElementTypeCell" AND label == "Cup"',
} as const;

const SIGN_IN_PROMPT_CONTINUE = 'type == "XCUIElementTypeButton" AND label == "Continue"';

export async function openIosAppDevice(target: IosTarget): Promise<IosAppDevice> {
  const [wdaLocalPort, mjpegServerPort] = [await reservePort(), await reservePort()];
  const capabilities = {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:udid": target.udid,
    "appium:platformVersion": target.platformVersion,
    "appium:bundleId": BUNDLE_ID,
    "appium:autoLaunch": false,
    "appium:noReset": true,
    "appium:wdaLocalPort": wdaLocalPort,
    "appium:mjpegServerPort": mjpegServerPort,
    "appium:usePrebuiltWDA": true,
    "appium:derivedDataPath": target.webDriverAgentDerivedData,
    "appium:wdaLaunchTimeout": 120_000,
    "appium:webviewConnectTimeout": 20_000,
    "appium:newCommandTimeout": 600,
  };
  const driver = await openAppiumSession(target.appiumPort, capabilities);
  return new IosAppDevice(target, driver);
}

export class IosAppDevice implements AppDevice {
  readonly platform = "ios";
  private readonly target: IosTarget;
  private readonly driver: WebdriverIO.Browser;
  private readonly relays = new Map<number, LoopbackRelay>();
  private lastLaunchArguments: IosLaunchArguments | undefined;
  private testStart: number | undefined;

  constructor(target: IosTarget, driver: WebdriverIO.Browser) {
    this.target = target;
    this.driver = driver;
  }

  async exposeHostPort(port: number): Promise<boolean> {
    const relay = await startLoopbackRelay(port);
    if (relay === undefined) {
      return false;
    }
    this.relays.set(port, relay);
    return true;
  }

  async unexposeHostPort(port: number): Promise<void> {
    await this.relays.get(port)?.close();
    this.relays.delete(port);
  }

  async launch(launchArguments: IosLaunchArguments): Promise<void> {
    this.lastLaunchArguments = launchArguments;
    await this.terminate();
    await this.driver.execute("mobile: launchApp", {
      bundleId: BUNDLE_ID,
      arguments: [
        `-${API_ORIGIN_KEY}`,
        launchArguments.apiOrigin,
        ...(launchArguments.testSentryDsn === undefined
          ? []
          : [`-${SENTRY_DSN_KEY}`, launchArguments.testSentryDsn]),
        ...(launchArguments.cancelAppleSignIn === true
          ? [`-${CANCEL_APPLE_SIGN_IN_KEY}`, "YES"]
          : []),
      ],
    });
  }

  async relaunch(): Promise<void> {
    if (this.lastLaunchArguments === undefined) {
      throw new Error("Cup has not been launched in this spec file, so it cannot be relaunched.");
    }
    await this.launch(this.lastLaunchArguments);
  }

  async clearAppData(): Promise<void> {
    await this.driver.execute("mobile: removeApp", { bundleId: BUNDLE_ID });
    await run("xcrun", ["simctl", "keychain", this.target.udid, "reset"]);
    await this.driver.execute("mobile: installApp", { app: this.target.appPath });
  }

  async terminate(): Promise<void> {
    await this.driver.execute("mobile: terminateApp", { bundleId: BUNDLE_ID });
  }

  async background(): Promise<void> {
    await this.driver.execute("mobile: pressButton", { name: "home" });
  }

  async bringToForeground(): Promise<void> {
    await this.driver.execute("mobile: activateApp", { bundleId: BUNDLE_ID });
  }

  async openUrl(url: string): Promise<void> {
    await this.driver.execute("mobile: deepLink", { url, bundleId: BUNDLE_ID });
  }

  async storeApiOrigin(apiOrigin: string): Promise<void> {
    await run("xcrun", [
      "simctl",
      "spawn",
      this.target.udid,
      "defaults",
      "write",
      BUNDLE_ID,
      API_ORIGIN_KEY,
      apiOrigin,
    ]);
  }

  async shareFromSafari(url: string): Promise<void> {
    await this.driver.switchContext("NATIVE_APP");
    await this.driver.execute("mobile: deepLink", { url, bundleId: SAFARI_BUNDLE_ID });
    await this.driver
      .$(
        `-ios predicate string:type == "XCUIElementTypeStaticText" AND label == "${SHARED_PAGE_HEADING}"`,
      )
      .waitForDisplayed({ timeout: 30_000, timeoutMsg: "Safari did not show the shared page." });
    await this.tap(SHARE_SHEET.more, "Safari's More button");
    await this.tap(SHARE_SHEET.share, "Share in Safari's More menu");
    await this.tap(SHARE_SHEET.cup, "Cup in the Share Sheet's app row");
    await waitFor(
      "Cup in the foreground after the share",
      async () => ((await this.appState("cup")) === "foreground" ? true : undefined),
      20_000,
    );
  }

  async appState(shareApp: ShareApp): Promise<AppiumAppState> {
    const state: unknown = await this.driver.execute("mobile: queryAppState", {
      bundleId: shareApp === "cup" ? BUNDLE_ID : SAFARI_BUNDLE_ID,
    });
    return toAppiumAppState(state, shareApp);
  }

  async statusBarHeight(): Promise<number> {
    await this.driver.switchContext("NATIVE_APP");
    const screenInfo: unknown = await this.driver.execute("mobile: deviceScreenInfo");
    if (
      typeof screenInfo !== "object" ||
      screenInfo === null ||
      !("statusBarSize" in screenInfo) ||
      typeof screenInfo.statusBarSize !== "object" ||
      screenInfo.statusBarSize === null ||
      !("height" in screenInfo.statusBarSize) ||
      typeof screenInfo.statusBarSize.height !== "number" ||
      screenInfo.statusBarSize.height <= 0
    ) {
      throw new Error(
        `Appium's mobile: deviceScreenInfo returned no status bar height: ${JSON.stringify(screenInfo)}`,
      );
    }
    return screenInfo.statusBarSize.height;
  }

  async continueGoogleSignIn(): Promise<void> {
    await this.driver.switchContext("NATIVE_APP");
    await this.tap(SIGN_IN_PROMPT_CONTINUE, "The prompt to sign in with localhost");
    await this.driver.$(`-ios predicate string:${SIGN_IN_PROMPT_CONTINUE}`).waitForExist({
      reverse: true,
      timeout: 10_000,
      timeoutMsg: "The prompt to sign in with localhost stayed open.",
    });
    await this.webView();
  }

  async webView(): Promise<WebdriverIO.Browser> {
    await this.driver.switchContext("NATIVE_APP");
    await this.driver
      .$("-ios class chain:**/XCUIElementTypeWebView/**/XCUIElementTypeStaticText[1]")
      .waitForExist({ timeout: 60_000, timeoutMsg: "Cup's WebView rendered no page." });
    const webViewContext = await waitFor(
      "Cup's WebView context",
      () => this.findCupPageContext(),
      30_000,
    );
    await this.driver.switchContext(webViewContext);
    return this.driver;
  }

  async markTestStart(): Promise<void> {
    this.testStart = performance.now();
  }

  failureArtifacts(): FailureArtifact[] {
    return appiumFailureArtifacts({
      driver: this.driver,
      findWebViewContext: () => this.findCupPageContext(),
      readDeviceLog: async () => {
        const elapsedMs = performance.now() - (this.testStart ?? performance.now());
        const minutes = Math.max(1, Math.ceil(elapsedMs / 60_000));
        const { stdout } = await run("xcrun", [
          "simctl",
          "spawn",
          this.target.udid,
          "log",
          "show",
          "--style",
          "compact",
          "--last",
          `${minutes}m`,
          "--predicate",
          DEVICE_LOG_PREDICATE,
        ]);
        return stdout;
      },
    });
  }

  async close(): Promise<void> {
    await Promise.all([...this.relays.keys()].map((port) => this.unexposeHostPort(port)));
    await this.driver.deleteSession();
  }

  async waitForProcessExit(): Promise<void> {
    await waitFor(
      "Cup's process to exit",
      async () => ((await this.appState("cup")) === "not running" ? true : undefined),
      30_000,
    );
  }

  async dataContainerPath(): Promise<string> {
    const { stdout } = await run("xcrun", [
      "simctl",
      "get_app_container",
      this.target.udid,
      BUNDLE_ID,
      "data",
    ]);
    return stdout.trim();
  }

  private async findCupPageContext(): Promise<string | undefined> {
    const contexts: unknown = await this.driver.execute("mobile: getContexts");
    return Array.isArray(contexts) ? contexts.findLast(isCupPage)?.id : undefined;
  }

  private async tap(predicate: string, description: string): Promise<void> {
    const element = this.driver.$(`-ios predicate string:${predicate}`);
    await element.waitForDisplayed({ timeout: 10_000, timeoutMsg: `${description} did not show.` });
    await element.click();
  }
}

export function asIosAppDevice(device: AppDevice): IosAppDevice {
  if (!(device instanceof IosAppDevice)) {
    throw new Error(`Expected the iOS device, got ${device.platform}.`);
  }
  return device;
}

function isCupPage(context: unknown): context is { id: string } {
  return (
    typeof context === "object" &&
    context !== null &&
    "id" in context &&
    typeof context.id === "string" &&
    context.id.startsWith("WEBVIEW_") &&
    "url" in context &&
    typeof context.url === "string" &&
    context.url.startsWith(CUP_PAGE_ORIGIN)
  );
}
