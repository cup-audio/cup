import { hc } from "hono/client";

import { trimTrailingSlash } from "@cup/api-rpc.client";
import type { ListenerApiApp, ListenerApiClient } from "@cup/listener-api.routes";

const hcWithType = (...args: Parameters<typeof hc>): ListenerApiClient =>
  hc<ListenerApiApp>(...args);

export type HonoClient = ReturnType<typeof hcWithType>;

export function createHonoClient(baseUrl: string): HonoClient {
  return hcWithType(trimTrailingSlash(baseUrl), {});
}
