import { App } from "@capacitor/app";

import { reportFailure } from "#src/report-failure.js";

export function watchAppState(listener: (isActive: boolean) => void): () => void {
  let isWatching = true;
  let hasReportedChange = false;

  const registration = App.addListener("appStateChange", ({ isActive }) => {
    hasReportedChange = true;
    if (isWatching) {
      listener(isActive);
    }
  });
  registration.catch(reportFailure("Failed to listen for app state changes"));

  const reportCurrentState = async () => {
    const { isActive } = await App.getState();
    if (isWatching && !hasReportedChange) {
      listener(isActive);
    }
  };
  reportCurrentState().catch(reportFailure("Failed to read the app state"));

  return () => {
    isWatching = false;
    registration
      .then((handle) => handle.remove())
      .catch(reportFailure("Failed to stop listening for app state changes"));
  };
}

export async function initializeAuthStorage(storageKeys: readonly string[]) {
  const storage = (await import("@aparajita/capacitor-secure-storage")).SecureStorage;
  return {
    storage,
    detectSessionInUrl: false,
    clearStoredSession: async () => {
      for (const key of storageKeys) {
        await storage.removeItem(key);
      }
    },
  };
}
