import { hc } from "hono/client";

import type { createListenerContractApp } from "#src/hono-app.ts";

export type ListenerApiApp = ReturnType<typeof createListenerContractApp>;

export type ListenerApiClient = ReturnType<typeof hc<ListenerApiApp>>;
