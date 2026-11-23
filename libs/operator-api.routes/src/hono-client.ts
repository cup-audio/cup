import { hc } from "hono/client";

import type { createOperatorApi } from "#src/hono-app.ts";

export type OperatorApiApp = ReturnType<typeof createOperatorApi>;
export type OperatorApiClient = ReturnType<typeof hc<OperatorApiApp>>;
