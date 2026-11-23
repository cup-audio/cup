import { Capacitor, registerPlugin } from "@capacitor/core";

type CrashReportingPlugin = {
  isEnabled(): Promise<{ enabled: boolean }>;
  setEnabled(options: { enabled: boolean }): Promise<void>;
};

const crashReportingPlugin = registerPlugin<CrashReportingPlugin>("CrashReporting");

export function hasCrashReportsSwitch(): boolean {
  return Capacitor.isNativePlatform();
}

export async function readCrashReportsEnabled(): Promise<boolean> {
  const { enabled } = await crashReportingPlugin.isEnabled();
  return enabled;
}

export async function writeCrashReportsEnabled(enabled: boolean): Promise<void> {
  await crashReportingPlugin.setEnabled({ enabled });
}
