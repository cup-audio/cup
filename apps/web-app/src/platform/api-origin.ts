import { Capacitor } from "@capacitor/core";

const TEST_API_ORIGIN_GLOBAL = "cupTestApiOrigin";

export function apiOrigin(): string {
  if (!Capacitor.isNativePlatform()) {
    return window.location.origin;
  }
  const testApiOrigin: unknown = Reflect.get(window, TEST_API_ORIGIN_GLOBAL);
  return typeof testApiOrigin === "string" ? testApiOrigin : "https://cup.audio";
}
