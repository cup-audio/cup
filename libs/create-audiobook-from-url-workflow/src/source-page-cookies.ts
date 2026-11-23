import { z } from "zod";

import { CupError } from "@cup/errors";
import type { SourcePageCookie } from "@cup/prepare-source-material";

const SOURCE_PAGE_COOKIES_SCHEMA = z.array(
  z.strictObject({
    name: z.string().min(1),
    value: z.string(),
    domain: z
      .string()
      .regex(/^\.?[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/i),
    path: z.string().startsWith("/"),
  }),
);

export function parseSourcePageCookies(configuration: string | undefined): SourcePageCookie[] {
  if (configuration === undefined) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configuration);
  } catch {
    throw new CupError("SOURCE_PAGE_COOKIES_JSON must contain valid JSON");
  }

  const result = SOURCE_PAGE_COOKIES_SCHEMA.safeParse(parsed);
  if (!result.success) {
    throw new CupError(
      "SOURCE_PAGE_COOKIES_JSON must be an array of cookies with a non-empty name, string value, hostname domain, and absolute path",
    );
  }

  return result.data;
}
