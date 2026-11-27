import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { TestContext } from "vitest";

import { runCli } from "#src/cli.ts";

const FILES = [
  "apps/cloudflare-worker/.env.local",
  "libs/narration-source-analysis/.env.evals",
] as const;
const CREDENTIALS = {
  CLOUDFLARE_ACCOUNT_ID: "abcdef0123456789",
  CLOUDFLARE_API_KEY: "secret-test-token",
};

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-setup-"));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of [
    "tooling/env-setup/src",
    "apps/cloudflare-worker",
    "libs/narration-source-analysis",
  ]) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  return {
    root,
    run: async (args: string[], credentials: Record<string, string> = CREDENTIALS) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const status = await runCli(args, root, credentials, {
        ...console,
        log: (message: string) => {
          stdout.push(message);
        },
        error: (message: string) => {
          stderr.push(message);
        },
      });
      return { status, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
    },
  };
}

test("check requires actual files even with exported credentials", async (t) => {
  const { run } = await fixture(t);
  const result = await run(["check"]);
  assert.equal(result.status, 1);
  for (const file of FILES) {
    assert.ok(result.stderr.includes(file));
  }
  assert.ok(result.stderr.includes("setup --from"));
  assert.ok(!result.stderr.includes(CREDENTIALS.CLOUDFLARE_API_KEY));
});

test("setup creates matching private files and preserves existing extra variables", async (t) => {
  const { root, run } = await fixture(t);
  assert.equal((await run(["setup"])).status, 0);
  assert.equal((await run(["check"])).status, 0);
  const file = path.join(root, FILES[0]);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.appendFile(file, "EXTRA=value\n");
  const original = await fs.readFile(file, "utf8");
  assert.equal((await run(["setup"])).status, 0);
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("source file initializes a worktree without exported credentials", async (t) => {
  const { root, run } = await fixture(t);
  const source = path.join(root, "source.env");
  await fs.writeFile(
    source,
    Object.entries(CREDENTIALS)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
  assert.equal((await run(["setup", "--from", source], {})).status, 0);
  assert.equal((await run(["check"], {})).status, 0);
});

test("invalid source reports all invalid keys without creating files", async (t) => {
  const { root, run } = await fixture(t);
  for (const value of ["", "your-api-key", "placeholder", "bad\nvalue"]) {
    const result = await run(["setup"], {
      CLOUDFLARE_ACCOUNT_ID: value,
      CLOUDFLARE_API_KEY: value,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CLOUDFLARE_ACCOUNT_ID/);
    assert.match(result.stderr, /CLOUDFLARE_API_KEY/);
  }
  for (const file of FILES) {
    await assert.rejects(fs.stat(path.join(root, file)), { code: "ENOENT" });
  }
});

test("conflicts fail before creating another file and never overwrite", async (t) => {
  const { root, run } = await fixture(t);
  const file = path.join(root, FILES[0]);
  const original = "CLOUDFLARE_ACCOUNT_ID=another-account\nCLOUDFLARE_API_KEY=another-secret\n";
  await fs.writeFile(file, original);
  const result = await run(["setup"]);
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes("another-secret"));
  assert.equal(await fs.readFile(file, "utf8"), original);
  await assert.rejects(fs.stat(path.join(root, FILES[1])), { code: "ENOENT" });
  await fs.writeFile(
    path.join(root, FILES[1]),
    Object.entries(CREDENTIALS)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );
  assert.equal((await run(["check"])).status, 1);
});

test("check rejects empty and placeholder values in existing files", async (t) => {
  const { root, run } = await fixture(t);
  assert.equal((await run(["setup"])).status, 0);
  await fs.writeFile(
    path.join(root, FILES[1]),
    "CLOUDFLARE_ACCOUNT_ID=\nCLOUDFLARE_API_KEY=your-api-key\n",
  );
  const result = await run(["check"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLOUDFLARE_ACCOUNT_ID is missing or empty/);
  assert.match(result.stderr, /CLOUDFLARE_API_KEY is a placeholder/);
});

test("check rejects a Sentry auth token in an environment file", async (t) => {
  const { root, run } = await fixture(t);
  assert.equal((await run(["setup"])).status, 0);
  await fs.appendFile(path.join(root, FILES[0]), "SENTRY_AUTH_TOKEN=sntrys_secret-upload-token\n");
  const result = await run(["check"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /apps\/cloudflare-worker\/\.env\.local: SENTRY_AUTH_TOKEN/);
  assert.match(result.stderr, /sentry-cli login/);
  assert.ok(!result.stderr.includes("sntrys_secret-upload-token"));
});

test("help describes commands without requiring credentials", async (t) => {
  const { run } = await fixture(t);
  const result = await run(["--help"], {});
  assert.equal(result.status, 0);
  assert.match(result.stdout, /setup/);
  assert.match(result.stdout, /check/);
  assert.equal(result.stderr, "");
  const setupHelp = await run(["setup", "--help"], {});
  assert.equal(setupHelp.status, 0);
  assert.match(setupHelp.stdout, /--from <env-file>/);
});

test("invalid command arguments fail before creating files", async (t) => {
  const { root, run } = await fixture(t);
  for (const args of [
    ["unknown"],
    ["setup", "--from"],
    ["check", "--from", "source.env"],
    ["setup", "unexpected"],
  ]) {
    const result = await run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /error:/);
  }
  for (const file of FILES) {
    await assert.rejects(fs.stat(path.join(root, file)), { code: "ENOENT" });
  }
});

const UPLOAD_KEYSTORE = "apps/mobile-app/android/upload-keystore.jks";

async function mainCheckoutWithUploadKeystore(t: TestContext, content: string | null) {
  const mainCheckout = await fs.mkdtemp(path.join(os.tmpdir(), "env-setup-main-"));
  t.onTestFinished(() => fs.rm(mainCheckout, { recursive: true, force: true }));
  if (content !== null) {
    await fs.mkdir(path.join(mainCheckout, path.dirname(UPLOAD_KEYSTORE)), { recursive: true });
    await fs.writeFile(path.join(mainCheckout, UPLOAD_KEYSTORE), content);
  }
  return mainCheckout;
}

test("copy-upload-key copies the main checkout's upload keystore into a worktree without one", async (t) => {
  const { root, run } = await fixture(t);
  const mainCheckout = await mainCheckoutWithUploadKeystore(t, "main keystore");

  const result = await run(["copy-upload-key", "--from", mainCheckout], {});

  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(`Copied ${UPLOAD_KEYSTORE}`));
  const copy = path.join(root, UPLOAD_KEYSTORE);
  assert.equal(await fs.readFile(copy, "utf8"), "main keystore");
  assert.equal((await fs.stat(copy)).mode & 0o777, 0o600);
});

test("copy-upload-key leaves a worktree's own upload keystore alone", async (t) => {
  const { root, run } = await fixture(t);
  const mainCheckout = await mainCheckoutWithUploadKeystore(t, "main keystore");
  await fs.mkdir(path.join(root, path.dirname(UPLOAD_KEYSTORE)), { recursive: true });
  await fs.writeFile(path.join(root, UPLOAD_KEYSTORE), "worktree keystore");

  const result = await run(["copy-upload-key", "--from", mainCheckout], {});

  assert.equal(result.status, 0);
  assert.ok(!result.stdout.includes("Copied"));
  assert.equal(await fs.readFile(path.join(root, UPLOAD_KEYSTORE), "utf8"), "worktree keystore");
});

test("copy-upload-key succeeds without copying when the main checkout has no upload keystore", async (t) => {
  const { root, run } = await fixture(t);
  const mainCheckout = await mainCheckoutWithUploadKeystore(t, null);

  const result = await run(["copy-upload-key", "--from", mainCheckout], {});

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  await assert.rejects(fs.stat(path.join(root, UPLOAD_KEYSTORE)), { code: "ENOENT" });
});

test("check passes without an upload keystore", async (t) => {
  const { root, run } = await fixture(t);
  assert.equal((await run(["setup"])).status, 0);

  assert.equal((await run(["check"])).status, 0);
  await assert.rejects(fs.stat(path.join(root, UPLOAD_KEYSTORE)), { code: "ENOENT" });
});
