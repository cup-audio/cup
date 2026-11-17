import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test, type TestContext } from "vitest";

import { runCli } from "#src/upload-shell-symbols-cli.ts";
import {
  spawnSentryCli,
  uploadShellSymbols,
  type RunSentryCli,
  type ShellSymbolsTarget,
} from "#src/upload-shell-symbols.ts";

const DEBUG_ID = "a6580e48-f307-57eb-82d5-d80321925191";
const OTHER_DEBUG_ID = "0b6d1f43-3f8e-5c0a-9d7e-2a4f7c1e9b52";

test("uploads an iOS archive's dSYMs and the source maps of the web bundle packed into it", async ({
  onTestFinished,
}) => {
  const root = await createRelease(onTestFinished);
  const { runSentryCli, commands } = recordSentryCli();

  await uploadShellSymbols(iosTarget(root), runSentryCli);

  expect(commands).toEqual([
    "info",
    `debug-files upload --project cup-app --wait ${path.join(root, "App.xcarchive/dSYMs")}`,
    `sourcemaps upload --project cup-app --strict ${path.join(root, "App.xcarchive/Products/Applications/App.app/public")} ${path.join(root, "source-maps")}`,
  ]);
});

test("uploads the source maps of the web bundle packed into the Android project", async ({
  onTestFinished,
}) => {
  const root = await createRelease(onTestFinished);
  const { runSentryCli, commands } = recordSentryCli();

  await uploadShellSymbols(androidTarget(root), runSentryCli);

  expect(commands).toEqual([
    "info",
    `sourcemaps upload --project cup-app --strict ${path.join(root, "android-public")} ${path.join(root, "source-maps")}`,
  ]);
});

test.for([
  { failing: "info", ran: ["info"] },
  { failing: "debug-files upload", ran: ["info", "debug-files upload"] },
  { failing: "sourcemaps upload", ran: ["info", "debug-files upload", "sourcemaps upload"] },
])(
  "stops and says not to upload the build to the store when `sentry-cli $failing` fails",
  async ({ failing, ran }, { onTestFinished }) => {
    const root = await createRelease(onTestFinished);
    const { runSentryCli, commands } = recordSentryCli(failing);

    await expect(uploadShellSymbols(iosTarget(root), runSentryCli)).rejects.toThrow(
      new RegExp(
        `^\`sentry-cli ${failing}[^\`]*\` failed with exit code 1\\. Do not upload this build to the store\\.$`,
      ),
    );

    expect(commands.map((command) => command.split(" --")[0])).toEqual(ran);
  },
);

test("fails when Sentry rejects the upload", async ({ onTestFinished }) => {
  const root = await createRelease(onTestFinished);
  const sentry = await startFailingSentry(onTestFinished);
  // An empty home directory has no `~/.sentryclirc`, so the operator's upload token cannot be used;
  // the token and the URL come from the same source, so Sentry CLI talks to the local server only.
  const environment = {
    PATH: process.env["PATH"],
    HOME: root,
    SENTRY_URL: sentry.url,
    SENTRY_AUTH_TOKEN: "sntryu_test",
    SENTRY_ORG: "cupaudio",
    SENTRY_DISABLE_UPDATE_CHECK: "true",
  };

  for (const target of [iosTarget(root), androidTarget(root)]) {
    await expect(
      uploadShellSymbols(target, async (args) =>
        args[0] === "info" ? 0 : spawnSentryCli(args, { environment, stdio: "ignore" }),
      ),
    ).rejects.toThrow(/failed with exit code 1\. Do not upload this build to the store\.$/);
  }

  expect(sentry.requests).toEqual([
    "GET /api/0/organizations/cupaudio/chunk-upload/",
    "GET /api/0/organizations/cupaudio/chunk-upload/",
  ]);
});

test("refuses source maps that belong to another build than the packed web bundle", async ({
  onTestFinished,
}) => {
  const root = await createRelease(onTestFinished, { packedDebugId: OTHER_DEBUG_ID });
  const { runSentryCli, commands } = recordSentryCli();

  await expect(uploadShellSymbols(androidTarget(root), runSentryCli)).rejects.toThrow(
    `The web bundle packed in ${path.join(root, "android-public")} lacks the debug IDs of 1 of 1 source maps in ${path.join(root, "source-maps")}`,
  );

  expect(commands).toEqual([]);
});

test("refuses an empty source map directory", async ({ onTestFinished }) => {
  const root = await createRelease(onTestFinished);
  await fs.rm(path.join(root, "source-maps"), { recursive: true });
  await fs.mkdir(path.join(root, "source-maps"));
  const { runSentryCli, commands } = recordSentryCli();

  await expect(uploadShellSymbols(androidTarget(root), runSentryCli)).rejects.toThrow(
    `Found no source map with a debug ID in ${path.join(root, "source-maps")}`,
  );

  expect(commands).toEqual([]);
});

test("refuses an iOS archive without dSYMs", async ({ onTestFinished }) => {
  const root = await createRelease(onTestFinished);
  await fs.rm(path.join(root, "App.xcarchive/dSYMs/App.app.dSYM"), { recursive: true });
  const { runSentryCli, commands } = recordSentryCli();

  await expect(uploadShellSymbols(iosTarget(root), runSentryCli)).rejects.toThrow(
    `Found no dSYM in ${path.join(root, "App.xcarchive/dSYMs")}`,
  );

  expect(commands).toEqual([]);
});

test("the CLI exits with 1 and prints why when an upload fails", async ({ onTestFinished }) => {
  const root = await createRelease(onTestFinished);
  const { runSentryCli, commands } = recordSentryCli("sourcemaps upload");
  const errors: string[] = [];

  const exitCode = await runCli(
    [...cliOptions(root), "ios", path.join(root, "App.xcarchive")],
    runSentryCli,
    { log: () => {}, error: (message: string) => errors.push(message) },
  );

  expect(exitCode).toBe(1);
  expect(commands.map((command) => command.split(" --")[0])).toEqual([
    "info",
    "debug-files upload",
    "sourcemaps upload",
  ]);
  expect(errors).toEqual([
    expect.stringMatching(/^`sentry-cli sourcemaps upload .*` failed with exit code 1\./),
  ]);
});

test("the CLI uploads the Android release from the packed Android web bundle", async ({
  onTestFinished,
}) => {
  const root = await createRelease(onTestFinished);
  const { runSentryCli, commands } = recordSentryCli();

  const exitCode = await runCli([...cliOptions(root), "android"], runSentryCli, {
    log: () => {},
    error: () => {},
  });

  expect(exitCode).toBe(0);
  expect(commands).toEqual([
    "info",
    `sourcemaps upload --project cup-app --strict ${path.join(root, "android-public")} ${path.join(root, "source-maps")}`,
  ]);
});

test("the CLI requires the archive for iOS", async ({ onTestFinished }) => {
  const root = await createRelease(onTestFinished);
  const { runSentryCli, commands } = recordSentryCli();
  const errors: string[] = [];

  const exitCode = await runCli([...cliOptions(root), "ios"], runSentryCli, {
    log: () => {},
    error: (message: string) => errors.push(message),
  });

  expect(exitCode).toBe(1);
  expect(errors).toEqual(["Pass the path of the release's .xcarchive after `ios`."]);
  expect(commands).toEqual([]);
});

function cliOptions(root: string) {
  return [
    "--web-source-map-dir",
    path.join(root, "source-maps"),
    "--android-web-dir",
    path.join(root, "android-public"),
  ];
}

function iosTarget(root: string): ShellSymbolsTarget {
  return {
    platform: "ios",
    archive: path.join(root, "App.xcarchive"),
    webSourceMapDir: path.join(root, "source-maps"),
  };
}

function androidTarget(root: string): ShellSymbolsTarget {
  return {
    platform: "android",
    packedWebDir: path.join(root, "android-public"),
    webSourceMapDir: path.join(root, "source-maps"),
  };
}

/**
 * A web build's source maps, the same bundle packed into the Android project and into an Xcode
 * archive, and the archive's dSYMs, laid out as Capacitor and Xcode leave them.
 */
async function createRelease(
  onTestFinished: TestContext["onTestFinished"],
  { packedDebugId = DEBUG_ID } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shell-symbols-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));

  const chunk = `console.log("entry");\n//# debugId=${packedDebugId}\n`;
  const files: Record<string, string> = {
    "source-maps/app/assets/entry-abc.js.map": JSON.stringify({
      version: 3,
      file: "entry-abc.js",
      sources: ["entry.ts"],
      mappings: "AAAA",
      debugId: DEBUG_ID,
    }),
    "android-public/app/assets/entry-abc.js": chunk,
    // Capacitor adds its own scripts, which carry no debug ID.
    "android-public/cordova.js": "",
    "App.xcarchive/Products/Applications/App.app/public/app/assets/entry-abc.js": chunk,
    "App.xcarchive/Products/Applications/App.app/public/cordova.js": "",
    "App.xcarchive/dSYMs/App.app.dSYM/Contents/Resources/DWARF/App": "",
  };
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  return root;
}

function recordSentryCli(failingCommand?: string) {
  const commands: string[] = [];
  const runSentryCli: RunSentryCli = async (args) => {
    const commandLine = args.join(" ");
    commands.push(commandLine);
    return failingCommand !== undefined && commandLine.startsWith(failingCommand) ? 1 : 0;
  };
  return { runSentryCli, commands };
}

async function startFailingSentry(onTestFinished: TestContext["onTestFinished"]) {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ detail: "Upload failed." }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The fake Sentry server listens on no TCP port.");
  }
  return { url: `http://127.0.0.1:${address.port}/`, requests };
}
