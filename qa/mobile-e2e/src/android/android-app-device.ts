import type { AppDevice, LaunchArguments } from "#src/app-device.ts";
import { openAppiumSession, toAppiumAppState, type AppiumAppState } from "#src/appium.ts";
import { appiumFailureArtifacts, type FailureArtifact } from "#src/failure-artifacts.ts";
import { reservePort, run, waitFor, type CommandResult } from "#src/host.ts";

export type AndroidTarget = {
  readonly serial: string;
  readonly adb: string;
  readonly appiumPort: number;
};

export type AndroidLaunchArguments = LaunchArguments & {
  readonly realGoogleSignIn?: boolean;
  readonly signedUrlLifetimeSeconds?: number;
  readonly foregroundGraceSeconds?: number;
};

const APP_PACKAGE = "audio.cup.app";
const MAIN_ACTIVITY = `${APP_PACKAGE}/.MainActivity`;
const API_ORIGIN_EXTRA = "cupTestApiOrigin";
const REAL_GOOGLE_SIGN_IN_EXTRA = "cupTestRealGoogleSignIn";
const SENTRY_DSN_EXTRA = "cupTestSentryDsn";
const SIGNED_URL_LIFETIME_EXTRA = "cupTestSignedUrlLifetimeSeconds";
const FOREGROUND_GRACE_EXTRA = "cupTestForegroundGraceSeconds";
const WEBVIEW_CONTEXT = `WEBVIEW_${APP_PACKAGE}`;
const FOCUS_PROBE_ACTION = `${APP_PACKAGE}.FOCUS_PROBE`;
const SYSTEM_UI_PACKAGE = "com.android.systemui";

export type FocusProbeRequest = "transient" | "duck" | "full" | "abandon";

export async function openAndroidAppDevice(target: AndroidTarget): Promise<AndroidAppDevice> {
  const [systemPort, chromedriverPort] = [await reservePort(), await reservePort()];
  const capabilities = {
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:udid": target.serial,
    "appium:appPackage": APP_PACKAGE,
    "appium:appActivity": ".MainActivity",
    "appium:autoLaunch": false,
    "appium:noReset": true,
    "appium:systemPort": systemPort,
    "appium:chromedriverPort": chromedriverPort,
    "appium:chromedriverAutodownload": true,
    "appium:newCommandTimeout": 600,
    "appium:skipLogcatCapture": true,
    "appium:ensureWebviewsHavePages": false,
    "appium:enableWebviewDetailsCollection": false,
  };
  const driver = await openAppiumSession(target.appiumPort, capabilities);
  return new AndroidAppDevice(target, driver);
}

export class AndroidAppDevice implements AppDevice {
  readonly platform = "android";
  private readonly target: AndroidTarget;
  private readonly driver: WebdriverIO.Browser;
  private lastLaunchArguments: AndroidLaunchArguments | undefined;
  private testStart: string | undefined;

  constructor(target: AndroidTarget, driver: WebdriverIO.Browser) {
    this.target = target;
    this.driver = driver;
  }

  async exposeHostPort(port: number): Promise<boolean> {
    try {
      await this.adb(["reverse", `tcp:${port}`, `tcp:${port}`]);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes("Address already in use")) {
        return false;
      }
      throw error;
    }
  }

  async unexposeHostPort(port: number): Promise<void> {
    await this.adb(["reverse", "--remove", `tcp:${port}`]);
  }

  async launch(launchArguments: AndroidLaunchArguments): Promise<void> {
    this.lastLaunchArguments = launchArguments;
    await this.adb([
      "shell",
      "am",
      "start",
      "-W",
      "-S",
      "-n",
      MAIN_ACTIVITY,
      ...launchArgumentExtras(launchArguments),
    ]);
  }

  async share(text: string, launchArguments: AndroidLaunchArguments): Promise<void> {
    this.lastLaunchArguments = launchArguments;
    await this.adb([
      "shell",
      "am",
      "start",
      "-W",
      "-n",
      MAIN_ACTIVITY,
      "-a",
      "android.intent.action.SEND",
      "-t",
      "text/plain",
      "--es",
      "android.intent.extra.TEXT",
      text,
      ...launchArgumentExtras(launchArguments),
    ]);
  }

  async reopen(): Promise<void> {
    if (this.lastLaunchArguments === undefined) {
      throw new Error("Cup has not been launched in this spec file, so it cannot be reopened.");
    }
    await this.adb([
      "shell",
      "am",
      "start",
      "-W",
      "-n",
      MAIN_ACTIVITY,
      ...launchArgumentExtras(this.lastLaunchArguments),
    ]);
  }

  async removeFromRecents(): Promise<void> {
    await this.adb(["shell", "input", "keyevent", "KEYCODE_APP_SWITCH"]);
    await this.driver.switchContext("NATIVE_APP");
    const card = this.driver.$(`android=new UiSelector().resourceIdMatches(".*:id/snapshot")`);
    await card.waitForExist({ timeout: 10_000 });
    let location = await card.getLocation();
    await waitFor(
      "Cup's card in the recent apps to settle",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const previous = location;
        location = await card.getLocation();
        return location.x === previous.x && location.y === previous.y ? true : undefined;
      },
      10_000,
    );
    const { x, y } = location;
    const { width, height } = await card.getSize();
    const centerX = Math.round(x + width / 2);
    await this.adb([
      "shell",
      "input",
      "swipe",
      String(centerX),
      String(Math.round(y + height / 2)),
      String(centerX),
      "0",
      "200",
    ]);
    await waitFor(
      "Cup's task to leave the recent apps",
      async () => {
        const { stdout } = await this.adb(["shell", "dumpsys", "activity", "recents"]);
        return new RegExp(
          String.raw`\bA=(?:\d+:)?${APP_PACKAGE.replaceAll(".", String.raw`\.`)}\b`,
          "u",
        ).test(stdout)
          ? undefined
          : true;
      },
      10_000,
    );
    await this.adb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
  }

  async relaunch(): Promise<void> {
    if (this.lastLaunchArguments === undefined) {
      throw new Error("Cup has not been launched in this spec file, so it cannot be relaunched.");
    }
    await this.leaveAndTerminate();
    await this.launch(this.lastLaunchArguments);
  }

  async leaveAndTerminate(): Promise<void> {
    await this.background();
    await waitFor(
      "Cup's activity to stop",
      async () => {
        const { stdout } = await this.adb([
          "shell",
          "dumpsys",
          "activity",
          "-p",
          APP_PACKAGE,
          "activities",
        ]);
        return /\bstate=STOPPED\b/u.test(stdout) ? true : undefined;
      },
      10_000,
    );
    await this.terminate();
  }

  async clearAppData(): Promise<void> {
    await this.adb(["shell", "pm", "clear", APP_PACKAGE]);
  }

  async terminate(): Promise<void> {
    await this.adb(["shell", "am", "force-stop", APP_PACKAGE]);
  }

  async background(): Promise<void> {
    await this.adb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
  }

  async focusedPackage(): Promise<string> {
    await this.driver.switchContext("NATIVE_APP");
    return this.driver.getCurrentPackage();
  }

  async browserPackage(url: string): Promise<string> {
    const { stdout } = await this.adb([
      "shell",
      "cmd",
      "package",
      "resolve-activity",
      "--brief",
      "-a",
      "android.intent.action.VIEW",
      "-c",
      "android.intent.category.BROWSABLE",
      "-d",
      url,
    ]);
    const component = stdout.trim().split("\n").at(-1) ?? "";
    const [browserPackage] = component.split("/");
    if (!browserPackage || !component.includes("/")) {
      throw new Error(`Android resolved no app for ${url}: ${stdout}`);
    }
    return browserPackage;
  }

  async appState(): Promise<AppiumAppState> {
    await this.driver.switchContext("NATIVE_APP");
    return toAppiumAppState(await this.driver.queryAppState(APP_PACKAGE), APP_PACKAGE);
  }

  async bringToForeground(): Promise<void> {
    await this.driver.switchContext("NATIVE_APP");
    await this.driver.activateApp(APP_PACKAGE);
  }

  async waitForKeyboard(state: "shown" | "hidden"): Promise<void> {
    await waitFor(
      state === "shown" ? "the on-screen keyboard to show" : "the on-screen keyboard to close",
      async () => {
        const { stdout } = await this.adb(["shell", "dumpsys", "window"]);
        return /\bmImeShowing=true\b/u.test(stdout) === (state === "shown") ? true : undefined;
      },
      10_000,
    );
  }

  async focusedActivity(): Promise<string> {
    await this.driver.switchContext("NATIVE_APP");
    const [appPackage, activity] = await Promise.all([
      this.driver.getCurrentPackage(),
      this.driver.getCurrentActivity(),
    ]);
    return `${appPackage}/${activity.startsWith(".") ? `${appPackage}${activity}` : activity}`;
  }

  async showsButton(appPackage: string): Promise<boolean> {
    await this.driver.switchContext("NATIVE_APP");
    const buttons = await this.driver.$$(
      `android=new UiSelector().packageName("${appPackage}").className("android.widget.Button")`,
    );
    return buttons.length > 0;
  }

  async pressBack(): Promise<void> {
    await this.adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
  }

  async pressMediaKey(keyCode: `KEYCODE_MEDIA_${string}`): Promise<void> {
    await this.adb(["shell", "input", "keyevent", keyCode]);
  }

  async turnScreenOff(): Promise<void> {
    await this.adb(["shell", "input", "keyevent", "KEYCODE_SLEEP"]);
  }

  async turnScreenOnAndUnlock(): Promise<void> {
    await this.adb(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
    await this.adb(["shell", "wm", "dismiss-keyguard"]);
  }

  async emulatorConsole(...args: string[]): Promise<string> {
    const { stdout } = await this.adb(["emu", ...args]);
    return stdout;
  }

  async probeAudioFocus(request: FocusProbeRequest): Promise<void> {
    await this.adb([
      "shell",
      "am",
      "broadcast",
      "-p",
      APP_PACKAGE,
      "-a",
      FOCUS_PROBE_ACTION,
      "--es",
      "focus",
      request,
    ]);
  }

  async isFrozen(): Promise<boolean> {
    const { stdout } = await this.adb(["shell", "dumpsys", "activity", "processes", APP_PACKAGE]);
    const record = stdout
      .split(/\n(?= {2}\*)/u)
      .find((entry) => new RegExp(`ProcessRecord\\{\\w+ \\d+:${APP_PACKAGE}/`, "u").test(entry));
    const frozen =
      record === undefined ? undefined : /\bisFrozen=(true|false)\b/u.exec(record)?.[1];
    if (frozen === undefined) {
      throw new Error(`Cup's process record shows no freezer state:\n${stdout}`);
    }
    return frozen === "true";
  }

  async tapMediaControl(description: string): Promise<void> {
    await this.inNotificationShade(async () => {
      const button = this.driver.$(
        `android=new UiSelector().packageName("${SYSTEM_UI_PACKAGE}").description("${description}")`,
      );
      await button.waitForExist({ timeout: 10_000 });
      await button.click();
    });
  }

  async dragMediaControlsSeekBar(fraction: number): Promise<void> {
    await this.inNotificationShade(async () => {
      const seekBar = this.driver.$(
        `android=new UiSelector().packageName("${SYSTEM_UI_PACKAGE}").className("android.widget.SeekBar")`,
      );
      await seekBar.waitForExist({ timeout: 10_000 });
      const { x, y } = await seekBar.getLocation();
      const { width, height } = await seekBar.getSize();
      const centerY = Math.round(y + height / 2);
      await this.adb([
        "shell",
        "input",
        "swipe",
        String(Math.round(x + width * 0.05)),
        String(centerY),
        String(Math.round(x + width * fraction)),
        String(centerY),
        "600",
      ]);
    });
  }

  async readMediaControlsProgress(): Promise<string> {
    return this.inNotificationShade(async () => {
      const progress = this.driver.$(
        `android=new UiSelector().packageName("${SYSTEM_UI_PACKAGE}").descriptionMatches(".+ of .+")`,
      );
      await progress.waitForExist({ timeout: 10_000 });
      return (await progress.getAttribute("content-desc")) ?? "";
    });
  }

  async hideMediaControls(): Promise<void> {
    await this.inNotificationShade(async () => {
      const seekBar = this.driver.$(
        `android=new UiSelector().packageName("${SYSTEM_UI_PACKAGE}").className("android.widget.SeekBar")`,
      );
      await seekBar.waitForExist({ timeout: 10_000 });
      const { x, y } = await seekBar.getLocation();
      const { width } = await seekBar.getSize();
      const pressX = String(Math.round(x + width / 2));
      const pressY = String(Math.round(y - 60));
      await this.adb(["shell", "input", "swipe", pressX, pressY, pressX, pressY, "1500"]);
      const hide = this.driver.$(
        `android=new UiSelector().packageName("${SYSTEM_UI_PACKAGE}").text("Hide")`,
      );
      await hide.waitForExist({ timeout: 10_000 });
      await hide.click();
    });
  }

  async dumpsys(service: string, ...args: string[]): Promise<string> {
    const { stdout } = await this.adb(["shell", "dumpsys", service, ...args]);
    return stdout;
  }

  async continueGoogleSignIn(): Promise<void> {}

  async webView(): Promise<WebdriverIO.Browser> {
    await this.driver.switchContext("NATIVE_APP");
    await waitFor("Cup's WebView", () => this.findWebViewContext(), 60_000);
    await this.driver.switchContext(WEBVIEW_CONTEXT);
    await waitFor(
      "Cup's WebView page",
      async () => {
        const handle = (await this.driver.getWindowHandles()).at(-1);
        if (handle === undefined) {
          return undefined;
        }
        await this.driver.switchToWindow(handle);
        return true;
      },
      60_000,
    );
    return this.driver;
  }

  async markTestStart(): Promise<void> {
    const { stdout } = await this.adb(["shell", "date", "+%s"]);
    this.testStart = `${stdout.trim()}.000`;
  }

  failureArtifacts(): FailureArtifact[] {
    return appiumFailureArtifacts({
      driver: this.driver,
      findWebViewContext: () => this.findWebViewContext(),
      readDeviceLog: async () => {
        const { stdout } = await this.adb([
          "logcat",
          "-d",
          "-v",
          "threadtime",
          ...(this.testStart === undefined ? [] : ["-T", this.testStart]),
        ]);
        return stdout;
      },
    });
  }

  async close(): Promise<void> {
    await this.driver.deleteSession();
  }

  async waitForProcessExit(): Promise<void> {
    await waitFor(
      "Cup's process to exit",
      async () => {
        const { exitCode } = await run(
          this.target.adb,
          ["-s", this.target.serial, "shell", "pidof", APP_PACKAGE],
          { successExitCodes: [0, 1] },
        );
        return exitCode === 1 ? true : undefined;
      },
      30_000,
    );
  }

  async processId(): Promise<string> {
    const { stdout } = await this.adb(["shell", "pidof", APP_PACKAGE]);
    return stdout.trim();
  }

  async appDataPaths(): Promise<string[]> {
    const { stdout } = await this.adb(["shell", "run-as", APP_PACKAGE, "find", "."]);
    return stdout.split("\n").filter((line) => line !== "");
  }

  private async inNotificationShade<Result>(act: () => Promise<Result>): Promise<Result> {
    await this.driver.switchContext("NATIVE_APP");
    await this.driver.openNotifications();
    try {
      return await act();
    } finally {
      await this.pressBack();
    }
  }

  private async findWebViewContext(): Promise<string | undefined> {
    const contexts = await this.driver.getContexts();
    const ids = contexts.map((context) => (typeof context === "string" ? context : context.id));
    return ids.includes(WEBVIEW_CONTEXT) ? WEBVIEW_CONTEXT : undefined;
  }

  private adb(args: readonly string[]): Promise<CommandResult> {
    const deviceArgs =
      args[0] === "shell" ? ["shell", ...args.slice(1).map(quoteForDeviceShell)] : args;
    return run(this.target.adb, ["-s", this.target.serial, ...deviceArgs]);
  }
}

export function asAndroidAppDevice(device: AppDevice): AndroidAppDevice {
  if (!(device instanceof AndroidAppDevice)) {
    throw new Error(`Expected the Android device, got ${device.platform}.`);
  }
  return device;
}

function launchArgumentExtras(launchArguments: AndroidLaunchArguments): string[] {
  return [
    "--es",
    API_ORIGIN_EXTRA,
    launchArguments.apiOrigin,
    ...(launchArguments.realGoogleSignIn === true
      ? ["--ez", REAL_GOOGLE_SIGN_IN_EXTRA, "true"]
      : []),
    ...(launchArguments.testSentryDsn === undefined
      ? []
      : ["--es", SENTRY_DSN_EXTRA, launchArguments.testSentryDsn]),
    ...(launchArguments.signedUrlLifetimeSeconds === undefined
      ? []
      : ["--ei", SIGNED_URL_LIFETIME_EXTRA, String(launchArguments.signedUrlLifetimeSeconds)]),
    ...(launchArguments.foregroundGraceSeconds === undefined
      ? []
      : ["--ei", FOREGROUND_GRACE_EXTRA, String(launchArguments.foregroundGraceSeconds)]),
  ];
}

function quoteForDeviceShell(arg: string): string {
  return /^[\w%+=:,./-]+$/u.test(arg) ? arg : `'${arg.replaceAll("'", String.raw`'\''`)}'`;
}
