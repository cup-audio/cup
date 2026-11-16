import { expect, test } from "#src/test-utils/component-test.ts";

test("the crash reports switch shows the shell's stored setting, on by default, and turns it off", async ({
  mount,
  page,
}) => {
  await page.addInitScript(() => {
    let isEnabled = true;
    const calls: unknown[] = [];
    Object.assign(window, {
      crashReportingCalls: calls,
      androidBridge: {},
      Capacitor: {
        PluginHeaders: [
          {
            name: "CrashReporting",
            methods: [
              { name: "isEnabled", rtype: "promise" },
              { name: "setEnabled", rtype: "promise" },
            ],
          },
        ],
        nativePromise: async (plugin: string, method: string, options: { enabled?: boolean }) => {
          calls.push({ plugin, method, options });
          if (plugin === "CrashReporting" && method === "isEnabled") {
            return { enabled: isEnabled };
          }
          if (plugin === "CrashReporting" && method === "setEnabled") {
            isEnabled = options.enabled === true;
            return {};
          }
          throw new Error(`Unexpected native call ${plugin}.${method}`);
        },
      },
    });
  });
  await mount("app/components/crash-reports-setting/Default");
  const crashReports = page.getByRole("switch", { name: "Send crash reports" });

  await expect(crashReports).toBeChecked();
  await crashReports.click();

  await expect(crashReports).not.toBeChecked();
  expect(await page.evaluate(() => Reflect.get(window, "crashReportingCalls"))).toContainEqual({
    plugin: "CrashReporting",
    method: "setEnabled",
    options: { enabled: false },
  });
});
