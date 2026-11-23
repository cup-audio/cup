import { expect, test, vi } from "vitest";

import { healthResponseSchema } from "@cup/listener-api.routes";

import type { ApiServerEnvironment } from "#src/api-server-environment.ts";
import { createApiServer } from "#src/api-server.ts";

import { toStrictSchema } from "#test/strict-schema.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly mocked = true;
  },
}));

const SETTINGS: Partial<ApiServerEnvironment> = { SUPABASE_URL: "https://access-test.supabase.co" };

test("the health endpoint answers 200 without touching a binding", async () => {
  const touched: string[] = [];
  const env = new Proxy(SETTINGS, {
    get(target, name) {
      if (typeof name === "string" && !(name in target)) {
        touched.push(name);
      }
      return Reflect.get(target, name);
    },
  });

  const response = await createApiServer().request("https://cup.audio/api/health", {}, env);

  expect(response.status).toBe(200);
  expect(toStrictSchema(healthResponseSchema).parse(await response.json())).toEqual({
    status: "ok",
  });
  expect(touched).toEqual([]);
});
