import type { TestProject } from "vitest/node";

import { startAppium, type AppiumServer } from "#src/appium.ts";
import { clearFailureArtifacts } from "#src/failure-artifacts.ts";
import { run } from "#src/host.ts";
import { buildIosDebugApp } from "#src/ios/build.ts";
import { checkIosHost } from "#src/ios/preflight.ts";
import { createSimulator, deleteOrphanedSimulators, type Simulator } from "#src/ios/simulator.ts";
import { ensureWebDriverAgent } from "#src/ios/web-driver-agent.ts";

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const host = await checkIosHost();
  await clearFailureArtifacts("ios");
  await deleteOrphanedSimulators();

  const started: { simulator?: Simulator; appium?: AppiumServer } = {};
  const teardown = async (): Promise<void> => {
    await Promise.all([started.simulator?.delete(), started.appium?.stop()]);
  };

  try {
    const [app, simulator, webDriverAgent] = await Promise.allSettled([
      buildIosDebugApp(),
      createSimulator(host).then((createdSimulator) => (started.simulator = createdSimulator)),
      startAppium({ drivers: ["xcuitest"], env: process.env }).then(async (startedAppium) => {
        started.appium = startedAppium;
        return {
          appiumPort: startedAppium.port,
          derivedData: await ensureWebDriverAgent(host),
        };
      }),
    ]);
    if (app.status === "rejected") {
      throw app.reason;
    }
    if (simulator.status === "rejected") {
      throw simulator.reason;
    }
    if (webDriverAgent.status === "rejected") {
      throw webDriverAgent.reason;
    }

    await run("xcrun", ["simctl", "install", simulator.value.udid, app.value]);
    project.provide("iosTarget", {
      udid: simulator.value.udid,
      platformVersion: host.runtime.version,
      appiumPort: webDriverAgent.value.appiumPort,
      appPath: app.value,
      webDriverAgentDerivedData: webDriverAgent.value.derivedData,
    });
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
