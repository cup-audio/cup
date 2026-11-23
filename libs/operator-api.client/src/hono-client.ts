import { hc } from "hono/client";

import { trimTrailingSlash } from "@cup/api-rpc.client";
import type { OperatorApiApp, OperatorApiClient } from "@cup/operator-api.routes";

const hcWithType = (...args: Parameters<typeof hc>): OperatorApiClient =>
  hc<OperatorApiApp>(...args);

export type HonoClient = ReturnType<typeof hcWithType>;

export function createHonoClient(baseUrl: string): HonoClient {
  return hcWithType(trimTrailingSlash(baseUrl), {});
}
