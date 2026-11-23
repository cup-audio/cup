import type { FailureArtifact } from "#src/failure-artifacts.ts";

export type MobilePlatform = "android" | "ios";

export type LaunchArguments = {
  readonly apiOrigin: string;
  readonly testSentryDsn?: string;
};

export type AppDevice = {
  readonly platform: MobilePlatform;
  exposeHostPort(port: number): Promise<boolean>;
  unexposeHostPort(port: number): Promise<void>;
  launch(launchArguments: LaunchArguments): Promise<void>;
  relaunch(): Promise<void>;
  clearAppData(): Promise<void>;
  terminate(): Promise<void>;
  background(): Promise<void>;
  bringToForeground(): Promise<void>;
  continueGoogleSignIn(): Promise<void>;
  webView(): Promise<WebdriverIO.Browser>;
  markTestStart(): Promise<void>;
  failureArtifacts(): FailureArtifact[];
  close(): Promise<void>;
};
