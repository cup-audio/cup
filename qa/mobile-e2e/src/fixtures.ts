/* oxlint-disable node/no-process-env -- The fixture reads the debugging flags. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, inject, type TestContext } from "vitest";

import { startSentryStub, type SentryStub } from "@cup/sentry-stub";
import {
  startAuthProvider,
  startTestWorker,
  type AuthProvider,
  type TestWorker,
} from "@cup/test-worker";

import { openAndroidAppDevice, type AndroidTarget } from "#src/android/android-app-device.ts";
import type { AppDevice, MobilePlatform } from "#src/app-device.ts";
import { failureArtifactFolder, writeFailureArtifacts } from "#src/failure-artifacts.ts";
import { openIosAppDevice, type IosTarget } from "#src/ios/ios-app-device.ts";

const RETAIN_WORKER_STATE = process.env["E2E_RETAIN_STATE"] === "1";
const STREAM_WORKER_LOGS = process.env["E2E_STREAM_WRANGLER"] === "1";
const PORT_ATTEMPTS = 5;

type TestServers = {
  authProvider?: AuthProvider;
  sentryStub?: SentryStub;
  worker?: TestWorker;
  exposedPorts: number[];
};

type UseMobileAppOptions = {
  sentryStub?: boolean;
};

declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Vitest types `provide` and `inject` through interface merging.
  interface ProvidedContext {
    mobilePlatform: MobilePlatform;
    androidTarget: AndroidTarget;
    iosTarget: IosTarget;
  }
}

export type MobileApp = {
  readonly device: AppDevice;
  readonly worker: TestWorker;
  readonly apiOrigin: string;
  readonly authProvider: AuthProvider;
  readonly sentryStub: SentryStub;
  readonly testSentryDsn: string;
};

export function useMobileApp(options: UseMobileAppOptions = {}): MobileApp {
  let device: AppDevice | undefined;
  let testServers: TestServers = { exposedPorts: [] };

  beforeAll(async () => {
    device = await openDevice(inject("mobilePlatform"));
  });

  afterAll(async () => {
    await device?.close();
  });

  beforeEach(async () => {
    const openedDevice = requireDefined(device, "The device session");
    testServers = { exposedPorts: [] };
    const { exposedPorts } = testServers;
    await openedDevice.clearAppData();
    await openedDevice.markTestStart();
    const authProvider = await startExposed(openedDevice, exposedPorts, {
      start: () => startAuthProvider({ hostname: "localhost" }),
      stop: (server) => server.close(),
    });
    testServers.authProvider = authProvider;
    if (options.sentryStub === true) {
      const { stub } = await startExposed(openedDevice, exposedPorts, {
        start: async () => {
          const startedStub = await startSentryStub();
          return { origin: startedStub.url, stub: startedStub };
        },
        stop: (server) => server.stub.close(),
      });
      testServers.sentryStub = stub;
    }
    const { sentryStub } = testServers;
    testServers.worker = await startExposed(openedDevice, exposedPorts, {
      start: () =>
        startTestWorker({
          authProviderOrigin: authProvider.origin,
          streamLogs: STREAM_WORKER_LOGS,
          ...(sentryStub === undefined ? {} : { sentryTunnelDsns: sentryStub.dsn("cup-app") }),
        }),
      stop: (server) => server.stop(),
    });
  });

  afterEach(async (context) => {
    const { worker, authProvider, sentryStub, exposedPorts } = testServers;
    testServers = { exposedPorts: [] };
    const failed = context.task.result?.state === "fail";
    const artifactFolder = failed
      ? failureArtifactFolder({
          platform: inject("mobilePlatform"),
          specFile: context.task.file.name,
          testNames: namesOf(context.task),
        })
      : undefined;

    if (artifactFolder !== undefined) {
      await writeFailureArtifacts(artifactFolder, [
        {
          fileName: "worker.log",
          capture: async () => requireDefined(worker, "This test's Worker").logs.join(""),
        },
        ...(device?.failureArtifacts() ?? []),
      ]);
      process.stderr.write(`Failure artifacts of "${context.task.name}": ${artifactFolder}\n`);
    }

    const retainPersistenceDirectory = failed && RETAIN_WORKER_STATE;
    try {
      await device?.terminate();
      for (const port of exposedPorts) {
        await device?.unexposeHostPort(port);
      }
    } finally {
      await worker?.stop({ retainPersistenceDirectory });
      await authProvider?.close();
      await sentryStub?.close();
    }
    if (retainPersistenceDirectory && worker !== undefined && artifactFolder !== undefined) {
      await fs.writeFile(
        path.join(artifactFolder, "worker-persistence-directory.txt"),
        `${worker.persistenceDirectory}\n`,
      );
      process.stderr.write(
        `Retained the Worker's persistence directory: ${worker.persistenceDirectory}\n`,
      );
    }
  });

  return {
    get device() {
      return requireDefined(device, "The device session");
    },
    get worker() {
      return requireDefined(testServers.worker, "This test's Worker");
    },
    get apiOrigin() {
      return localhostOrigin(
        portOf(requireDefined(testServers.worker, "This test's Worker").origin),
      );
    },
    get authProvider() {
      return requireDefined(testServers.authProvider, "This test's fake auth provider");
    },
    get sentryStub() {
      return requireDefined(testServers.sentryStub, "This test's Sentry stub");
    },
    get testSentryDsn() {
      return requireDefined(testServers.sentryStub, "This test's Sentry stub").dsn("cup-app");
    },
  };
}

async function openDevice(platform: MobilePlatform): Promise<AppDevice> {
  if (platform === "android") {
    return openAndroidAppDevice(inject("androidTarget"));
  }
  if (platform === "ios") {
    return openIosAppDevice(inject("iosTarget"));
  }
  throw new Error(`Unknown mobile platform: ${String(platform)}`);
}

async function startExposed<T extends { origin: string }>(
  device: AppDevice,
  exposedPorts: number[],
  lifecycle: { start(): Promise<T>; stop(server: T): Promise<void> },
): Promise<T> {
  const takenPorts: number[] = [];
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const server = await lifecycle.start();
    const port = portOf(server.origin);
    let exposed = false;
    try {
      exposed = await device.exposeHostPort(port);
    } finally {
      if (!exposed) {
        await lifecycle.stop(server);
      }
    }
    if (exposed) {
      exposedPorts.push(port);
      return server;
    }
    takenPorts.push(port);
  }
  throw new Error(
    `The device already used every port the host assigned for this test: ${takenPorts.join(", ")}.`,
  );
}

function localhostOrigin(port: number): string {
  return `http://localhost:${port}`;
}

function portOf(origin: string): number {
  return Number(new URL(origin).port);
}

function namesOf(task: TestContext["task"]): string[] {
  const names = [task.name];
  for (let suite = task.suite; suite?.suite !== undefined; suite = suite.suite) {
    names.unshift(suite.name);
  }
  return names;
}

function requireDefined<T>(value: T | undefined, description: string): T {
  if (value === undefined) {
    throw new Error(`${description} has not started.`);
  }
  return value;
}
