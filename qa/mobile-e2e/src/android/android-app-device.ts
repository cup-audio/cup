import type { AppDevice, LaunchArguments } from "#src/app-device.ts";
import { openAppiumSession, toAppiumAppState, type AppiumAppState } from "#src/appium.ts";
import { appiumFailureArtifacts, type FailureArtifact } from "#src/failure-artifacts.ts";
import { reservePort, run, waitFor, type CommandResult } from "#src/host.ts";

/** What the Android global setup hands each spec file: the run's device and Appium server. */
export type AndroidTarget = {
  readonly serial: string;
  readonly adb: string;
  readonly appiumPort: number;
};

export type AndroidLaunchArguments = LaunchArguments & {
  /**
   * Keeps the real Google sign-in plugin, which opens Google's own screens, instead of the debug
   * build's fake that signs in against the fake auth provider.
   */
  readonly realGoogleSignIn?: boolean;
  /**
   * The Sentry stub's `cup-app` DSN, `http://<key>@127.0.0.1:<port>/<project>`: the debug build
   * then reports to it, its JS events through the test Worker's telemetry tunnel. Without it, the
   * debug build sends nothing to Sentry.
   */
  readonly testSentryDsn?: string;
  /**
   * How long the native player treats signed URLs as valid; pass the test Worker's
   * `signedUrlLifetimeSeconds`.
   */
  readonly signedUrlLifetimeSeconds?: number;
  /** Media3's foreground grace after a pause, instead of 10 minutes. */
  readonly foregroundGraceSeconds?: number;
};

const APP_PACKAGE = "audio.cup.app";
const MAIN_ACTIVITY = `${APP_PACKAGE}/.MainActivity`;
/** Read only by the debug build's `TestApiOrigin`. */
const API_ORIGIN_EXTRA = "cupTestApiOrigin";
/** Read only by the debug build's `DebugApplication`. */
const REAL_GOOGLE_SIGN_IN_EXTRA = "cupTestRealGoogleSignIn";
/** Read only by the debug build's `TestSentryDsn`. */
const SENTRY_DSN_EXTRA = "cupTestSentryDsn";
/** Read only by the debug build's `TestPlaybackTimings`. */
const SIGNED_URL_LIFETIME_EXTRA = "cupTestSignedUrlLifetimeSeconds";
/** Read only by the debug build's `TestPlaybackTimings`. */
const FOREGROUND_GRACE_EXTRA = "cupTestForegroundGraceSeconds";
const WEBVIEW_CONTEXT = `WEBVIEW_${APP_PACKAGE}`;
/** Received only by the debug build's `FocusProbePlugin`. */
const FOCUS_PROBE_ACTION = `${APP_PACKAGE}.FOCUS_PROBE`;
/** System UI's media controls in the notification shade. */
const SYSTEM_UI_PACKAGE = "com.android.systemui";

/** Who takes audio focus from Cup through the debug build's focus probe, or gives it back. */
export type FocusProbeRequest =
  /** As a phone call: a transient loss. */
  | "transient"
  /** As a navigation prompt: a transient loss that allows ducking. */
  | "duck"
  /** As another media app: a permanent loss. */
  | "full"
  | "abandon";

/** Opens an Appium session on the run's emulator, addressed by serial, without launching Cup. */
export async function openAndroidAppDevice(target: AndroidTarget): Promise<AndroidAppDevice> {
  // UiAutomator2 forwards these host ports to the device; reserve them like every other port.
  const [systemPort, chromedriverPort] = [await reservePort(), await reservePort()];
  // WebdriverIO's capability types lack some UiAutomator2 options, so the object is not a literal.
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
    // Appium's logcat capture streams the whole log buffer, including the snapshot's boot log, the
    // moment the session starts and then every new line. That stream made the emulator drop its adb
    // connection now and then: "device offline" at session start, or a killed UiAutomator2 server
    // mid-test. No test reads the capture.
    "appium:skipLogcatCapture": true,
    // By default, listing contexts sends an HTTP request through `adb forward` to the devtools
    // socket of every app's WebView, Cup's or not. An app that Android's cached-apps freezer has
    // frozen, such as the Google app in the background, never accepts those
    // connections; once its socket's listen backlog is full, adbd blocks connecting to it and every
    // later adb call on the emulator hangs. Contexts are then listed from `/proc/net/unix` alone,
    // and Chromedriver attaches to Cup's WebView only.
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
  /** The emulator clock at the test start, in the epoch format `logcat -T` accepts. */
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
      // adbd listens on every address of the emulator, so any socket there holding the port blocks
      // it: Google Play services' connections and TIME_WAIT sockets use ports the host assigns too.
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
    // `-S` force-stops a running Cup first, so every launch is a cold start.
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

  /**
   * Shares `text` to Cup as another app's Sharesheet does: an explicit `ACTION_SEND` intent of type
   * `text/plain` to Cup's main activity, with the text in `android.intent.extra.TEXT`. A running
   * Cup receives it as a new intent; otherwise the intent starts Cup with the launch arguments.
   */
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

  /**
   * Opens Cup with the arguments of the last launch without stopping it first, as tapping its icon
   * does: a process that still runs, such as one kept by a playing media session, stays.
   */
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

  /**
   * Swipes Cup's task away in the recent apps screen, which destroys its activity; Android then
   * tells its running services through `onTaskRemoved`.
   */
  async removeFromRecents(): Promise<void> {
    await this.adb(["shell", "input", "keyevent", "KEYCODE_APP_SWITCH"]);
    await this.driver.switchContext("NATIVE_APP");
    // The launcher shows the recent apps with Cup's card, the latest task, in the middle. Its
    // snapshot exists only there, unlike a "Cup" label in Cup's own screen.
    const card = this.driver.$(`android=new UiSelector().resourceIdMatches(".*:id/snapshot")`);
    await card.waitForExist({ timeout: 10_000 });
    // The card slides into place; swipe it once it has stopped.
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

  /**
   * Sends Cup home, waits until Android reports its activity stopped, then force-stops it, as
   * Android ends a listener's app that has left the screen. Secure Storage writes the account
   * session to SharedPreferences with `apply()`, which reaches the disk later; force-stopping Cup
   * in the foreground right after a sign-in or sign-out lost that write in about one relaunch in
   * three (2026-11-10). Android waits for such writes before it reports the activity stopped.
   * `terminate()` force-stops at once, for the teardown, where Cup may not run at all.
   */
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

  /** The package of the app in the foreground, such as Google Play services over Cup. */
  async focusedPackage(): Promise<string> {
    await this.driver.switchContext("NATIVE_APP");
    return this.driver.getCurrentPackage();
  }

  /** Whether Cup's process runs and whether it is in the foreground. */
  async appState(): Promise<AppiumAppState> {
    await this.driver.switchContext("NATIVE_APP");
    return toAppiumAppState(await this.driver.queryAppState(APP_PACKAGE), APP_PACKAGE);
  }

  async bringToForeground(): Promise<void> {
    await this.driver.switchContext("NATIVE_APP");
    await this.driver.activateApp(APP_PACKAGE);
  }

  /**
   * Waits until the on-screen keyboard is on screen, or until it has left the screen, which the
   * system back button would otherwise close first.
   *
   * It reads the window manager's `mImeShowing`, which stays true until the keyboard's closing
   * animation ends. The input method's `mInputShown`, which `isKeyboardShown()` reads, turns false
   * as soon as a close is requested, and it never turned true when a field lost focus before the
   * keyboard had appeared: the keyboard then showed and closed over the next two seconds and took
   * the next Back press (2026-11-10).
   */
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

  /**
   * The focused activity as `<package>/<fully qualified class>`, which tells apart the screens of
   * one app, such as Google Play services' sign-in trampoline and its add-account screen.
   */
  async focusedActivity(): Promise<string> {
    await this.driver.switchContext("NATIVE_APP");
    const [appPackage, activity] = await Promise.all([
      this.driver.getCurrentPackage(),
      this.driver.getCurrentActivity(),
    ]);
    return `${appPackage}/${activity.startsWith(".") ? `${appPackage}${activity}` : activity}`;
  }

  /** Whether a button of `appPackage` is on screen, such as one on a page its WebView rendered. */
  async showsButton(appPackage: string): Promise<boolean> {
    await this.driver.switchContext("NATIVE_APP");
    const buttons = await this.driver.$$(
      `android=new UiSelector().packageName("${appPackage}").className("android.widget.Button")`,
    );
    return buttons.length > 0;
  }

  /** Presses the system back button. */
  async pressBack(): Promise<void> {
    await this.adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
  }

  /**
   * Presses a media key, such as `KEYCODE_MEDIA_PAUSE`, as a headset or a keyboard does. Android
   * delivers it to the active media session.
   */
  async pressMediaKey(keyCode: `KEYCODE_MEDIA_${string}`): Promise<void> {
    await this.adb(["shell", "input", "keyevent", keyCode]);
  }

  /** Turns the screen off, as the power button does; the keyguard has no PIN. */
  async turnScreenOff(): Promise<void> {
    await this.adb(["shell", "input", "keyevent", "KEYCODE_SLEEP"]);
  }

  /** Turns the screen on and dismisses the keyguard, which has no PIN. */
  async turnScreenOnAndUnlock(): Promise<void> {
    await this.adb(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
    await this.adb(["shell", "wm", "dismiss-keyguard"]);
  }

  /** Sends a command to the emulator's console, such as `gsm call <number>` for an incoming call. */
  async emulatorConsole(...args: string[]): Promise<string> {
    const { stdout } = await this.adb(["emu", ...args]);
    return stdout;
  }

  /** Takes audio focus from Cup, or gives it back, through the debug build's focus probe. */
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

  /**
   * Whether Android's cached apps freezer has frozen Cup's main process, from `dumpsys activity
   * processes`.
   */
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

  /**
   * Taps a button of the media controls in the notification shade by its description, such as
   * `Forward 15 seconds`, then closes the shade.
   */
  async tapMediaControl(description: string): Promise<void> {
    await this.inNotificationShade(async () => {
      const button = this.driver.$(
        `android=new UiSelector().packageName("${SYSTEM_UI_PACKAGE}").description("${description}")`,
      );
      await button.waitForExist({ timeout: 10_000 });
      await button.click();
    });
  }

  /**
   * Drags the seek bar of the media controls in the notification shade to `fraction` of its width,
   * then closes the shade.
   */
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

  /**
   * The progress the media controls in the notification shade show for the playing session, such as
   * `9 seconds of 19 seconds`: System UI's own reading of the session's position and duration,
   * which `dumpsys media_session` does not print. It opens the shade and closes it again.
   */
  async readMediaControlsProgress(): Promise<string> {
    return this.inNotificationShade(async () => {
      const progress = this.driver.$(
        `android=new UiSelector().packageName("${SYSTEM_UI_PACKAGE}").descriptionMatches(".+ of .+")`,
      );
      await progress.waitForExist({ timeout: 10_000 });
      return (await progress.getAttribute("content-desc")) ?? "";
    });
  }

  /**
   * Dismisses the media controls in the notification shade as a listener does since Android 13,
   * where they replace the media notification: a long press on the player, then "Hide". System UI
   * then cancels the notification, which Media3 hears as its dismissal. It is offered only once the
   * session's service left the foreground.
   */
  async hideMediaControls(): Promise<void> {
    await this.inNotificationShade(async () => {
      const seekBar = this.driver.$(
        `android=new UiSelector().packageName("${SYSTEM_UI_PACKAGE}").className("android.widget.SeekBar")`,
      );
      await seekBar.waitForExist({ timeout: 10_000 });
      const { x, y } = await seekBar.getLocation();
      const { width } = await seekBar.getSize();
      // Above the seek bar, on the player's title; a swipe that stays in place is a long press.
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

  /** The output of `dumpsys <service>`, such as `media_session` or `activity services`. */
  async dumpsys(service: string, ...args: string[]): Promise<string> {
    const { stdout } = await this.adb(["shell", "dumpsys", service, ...args]);
    return stdout;
  }

  async continueGoogleSignIn(): Promise<void> {
    // The debug build's sign-in fake answers without showing anything.
  }

  async webView(): Promise<WebdriverIO.Browser> {
    // A relaunch replaces the WebView's process, so attach to it anew.
    await this.driver.switchContext("NATIVE_APP");
    await waitFor("Cup's WebView", () => this.findWebViewContext(), 60_000);
    await this.driver.switchContext(WEBVIEW_CONTEXT);
    // Reopening Cup in a process that still runs, such as one a playing media session kept, creates
    // a new WebView page in the same context and closes the one Chromedriver was attached to.
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
      // A one-off dump of the log buffer since the test started. Appium's logcat capture stays off;
      // see `skipLogcatCapture`.
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

  /**
   * Waits until Cup's process has exited, such as after a crash, when Sentry's crash handler has
   * sent or stored the crash before handing it on to Android's, which ends the process.
   */
  async waitForProcessExit(): Promise<void> {
    await waitFor(
      "Cup's process to exit",
      async () => {
        // `pidof` exits with 1 once no process has the name.
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

  /**
   * Every file and folder in Cup's private data directory, as paths relative to it, such as
   * `./files/INSTALLATION`. The debug build is debuggable, so `run-as` reads it.
   */
  async appDataPaths(): Promise<string[]> {
    const { stdout } = await this.adb(["shell", "run-as", APP_PACKAGE, "find", "."]);
    return stdout.split("\n").filter((line) => line !== "");
  }

  /** Opens the notification shade for `act` and closes it again. */
  private async inNotificationShade<Result>(act: () => Promise<Result>): Promise<Result> {
    await this.driver.switchContext("NATIVE_APP");
    await this.driver.openNotifications();
    try {
      return await act();
    } finally {
      await this.pressBack();
    }
  }

  /** Cup's WebView context, once Appium lists it. */
  private async findWebViewContext(): Promise<string | undefined> {
    const contexts = await this.driver.getContexts();
    const ids = contexts.map((context) => (typeof context === "string" ? context : context.id));
    return ids.includes(WEBVIEW_CONTEXT) ? WEBVIEW_CONTEXT : undefined;
  }

  private adb(args: readonly string[]): Promise<CommandResult> {
    // `adb shell` joins its arguments into one command line for the device's shell, so each one is
    // quoted for that shell, such as shared text with spaces, `&` or `#`.
    const deviceArgs =
      args[0] === "shell" ? ["shell", ...args.slice(1).map(quoteForDeviceShell)] : args;
    return run(this.target.adb, ["-s", this.target.serial, ...deviceArgs]);
  }
}

/** For platform-only specs in `test/android/`, which run on the Android project only. */
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

/** Leaves plain words as they are and wraps anything else in single quotes. */
function quoteForDeviceShell(arg: string): string {
  return /^[\w%+=:,./-]+$/u.test(arg) ? arg : `'${arg.replaceAll("'", String.raw`'\''`)}'`;
}
