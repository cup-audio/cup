import type { SignInMethod } from "@cup/listener-api.routes";

export type ConfirmationProvider = Extract<SignInMethod, "apple" | "google">;

export function isAppleLinked(providers: readonly string[]): boolean {
  return providers.includes("apple");
}

export function confirmationProvider(
  providers: readonly string[],
): ConfirmationProvider | undefined {
  if (isAppleLinked(providers)) {
    return "apple";
  }
  return providers.includes("google") ? "google" : undefined;
}
