import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * The shells' own `CrashReporting` plugin, which keeps the "Send crash reports" switch in native
 * storage (SharedPreferences on Android, UserDefaults on iOS), on by default. Turning it off
 * deletes the files the native Sentry SDK keeps on the device.
 */
type CrashReportingPlugin = {
  isEnabled(): Promise<{ enabled: boolean }>;
  setEnabled(options: { enabled: boolean }): Promise<void>;
};

const crashReportingPlugin = registerPlugin<CrashReportingPlugin>("CrashReporting");

/** Only the shells have native crash reporting, and with it the switch; the browser has neither. */
export function hasCrashReportsSwitch(): boolean {
  return Capacitor.isNativePlatform();
}

/** Whether the shell's native SDK may run. Read before `Sentry.init`, which decides `enableNative`. */
export async function readCrashReportsEnabled(): Promise<boolean> {
  const { enabled } = await crashReportingPlugin.isEnabled();
  return enabled;
}

/**
 * Stores the switch. Off deletes the native SDK's files at once, and the next start runs Sentry
 * JS-only; the native SDK of the running process keeps running until then.
 */
export async function writeCrashReportsEnabled(enabled: boolean): Promise<void> {
  await crashReportingPlugin.setEnabled({ enabled });
}
