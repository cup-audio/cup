import nodeUrl from "node:url";
import { expect, test } from "vitest";
import { experimental_readRawConfig } from "wrangler";

const CONFIG_PATH = nodeUrl.fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

function readVars(): Record<string, unknown> {
  const { rawConfig }: { rawConfig: { vars?: Record<string, unknown> } } =
    experimental_readRawConfig({ config: CONFIG_PATH });
  return rawConfig.vars ?? {};
}

test("the test Worker runs as local development and sends nothing to Sentry", () => {
  const vars = readVars();

  expect(vars["LOCAL_DEVELOPMENT"]).toBe("true");
  expect(vars["SENTRY_DSN"]).toBe("");
  expect(vars["SENTRY_TUNNEL_DSNS"]).toBe("");
});

test("the test Worker advertises Apple sign-in next to Google", () => {
  const vars = readVars();

  expect(vars["APPLE_WEB_CLIENT_ID"]).toBe("audio.cup.app.web");
  expect(vars["GOOGLE_WEB_CLIENT_ID"]).toBe("qa-google-client");
});
