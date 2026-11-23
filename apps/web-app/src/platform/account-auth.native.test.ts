import type { Page } from "@playwright/test";

import { expect, test } from "#src/test-utils/component-test.ts";

type Shell = "android" | "ios";

type StoredItem = { data: string; access: unknown };

type StorageRecord = {
  read: string | null;
  items: Record<string, StoredItem>;
};

const SESSION_KEY = "cup-account-session";
const PREFIXED_SESSION_KEY = `capacitor-storage_${SESSION_KEY}`;

async function readThenWriteSession(
  page: Page,
  shell: Shell,
  existingItems: Record<string, StoredItem>,
  written: string,
): Promise<StorageRecord> {
  await page.addInitScript(
    ({ platform, items }) => {
      const store: Record<string, StoredItem> = { ...items };
      Object.assign(window, {
        ...(platform === "ios"
          ? { webkit: { messageHandlers: { bridge: {} } } }
          : { androidBridge: {} }),
        nativeStore: store,
        Capacitor: {
          PluginHeaders: [
            {
              name: "SecureStorage",
              methods: [
                { name: "internalSetItem", rtype: "promise" },
                { name: "internalGetItem", rtype: "promise" },
                { name: "internalRemoveItem", rtype: "promise" },
              ],
            },
          ],
          nativePromise: async (
            plugin: string,
            method: string,
            options: { prefixedKey: string; data?: string; access?: unknown },
          ) => {
            if (plugin !== "SecureStorage") {
              throw new Error(`Unexpected native call ${plugin}.${method}`);
            }
            if (method === "internalSetItem") {
              store[options.prefixedKey] = { data: options.data ?? "", access: options.access };
              return {};
            }
            if (method === "internalGetItem") {
              return { data: store[options.prefixedKey]?.data ?? null };
            }
            throw new Error(`Unexpected native call ${plugin}.${method}`);
          },
        },
      });
    },
    { platform: shell, items: existingItems },
  );
  await page.goto("");
  return page.evaluate(
    async ({ platform, key, value }) => {
      const modulePath = `/src/platform/account-auth.${platform}.ts`;
      const { initializeAuthStorage } = await import(modulePath);
      const { storage } = await initializeAuthStorage([key]);
      const read: string | null = await storage.getItem(key);
      await storage.setItem(key, value);
      return { read, items: Reflect.get(window, "nativeStore") };
    },
    { platform: shell, key: SESSION_KEY, value: written },
  );
}

test("the iOS shell writes the session readable after the device's first unlock", async ({
  page,
}) => {
  const record = await readThenWriteSession(page, "ios", {}, "the-session");

  expect(record.items).toEqual({ [PREFIXED_SESSION_KEY]: { data: "the-session", access: 2 } });
});

test("the iOS shell reads a session stored before the update and rewrites it after first unlock", async ({
  page,
}) => {
  const record = await readThenWriteSession(
    page,
    "ios",
    { [PREFIXED_SESSION_KEY]: { data: "the-old-session", access: 0 } },
    "the-refreshed-session",
  );

  expect(record).toEqual({
    read: "the-old-session",
    items: { [PREFIXED_SESSION_KEY]: { data: "the-refreshed-session", access: 2 } },
  });
});

test("the Android shell writes the session with the plugin's default access", async ({ page }) => {
  const record = await readThenWriteSession(page, "android", {}, "the-session");

  expect(record.items).toEqual({ [PREFIXED_SESSION_KEY]: { data: "the-session", access: 0 } });
});

test("reports the app's state at the start, then each foreground and background change", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      webkit: { messageHandlers: { bridge: {} } },
      Capacitor: {
        PluginHeaders: [
          {
            name: "App",
            methods: [
              { name: "addListener" },
              { name: "removeListener", rtype: "promise" },
              { name: "getState", rtype: "promise" },
            ],
          },
        ],
        nativePromise: async (plugin: string, method: string) => {
          if (plugin === "App" && method === "getState") {
            return { isActive: true };
          }
          if (plugin === "App" && method === "removeListener") {
            return undefined;
          }
          throw new Error(`Unexpected native call ${plugin}.${method}`);
        },
        nativeCallback: (
          _plugin: string,
          _method: string,
          _options: unknown,
          listener: (state: { isActive: boolean }) => void,
        ) => {
          window.addEventListener("test-app-state", (event) => {
            if (event instanceof CustomEvent) {
              listener({ isActive: Boolean(event.detail) });
            }
          });
          return "app-state-listener";
        },
      },
    });
  });
  await page.goto("");

  const reported = await page.evaluate(async () => {
    const modulePath = "/src/platform/account-auth.native.ts";
    const { watchAppState } = await import(modulePath);
    const states: boolean[] = [];
    const stopWatching = watchAppState((isActive: boolean) => states.push(isActive));
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const isActive of [false, true]) {
      window.dispatchEvent(new CustomEvent("test-app-state", { detail: isActive }));
    }
    stopWatching();
    window.dispatchEvent(new CustomEvent("test-app-state", { detail: false }));
    return states;
  });

  expect(reported).toEqual([true, false, true]);
});
