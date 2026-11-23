import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import util from "node:util";
import { Temporal } from "temporal-polyfill";

export const IDEMPOTENCY_KEY_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export type ResendStubRequest = {
  method: string;
  pathname: string;
  authorization: string | undefined;
  userAgent: string | undefined;
  idempotencyKey: string | undefined;
  body: unknown;
};

export type SentEmail = {
  id: string;
  idempotencyKey: string | undefined;
  email: unknown;
};

export type ScriptedResponse = {
  status: number;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
};

export type HeldRequest = {
  received: Promise<void>;
  release(): void;
};

export type ResendStub = {
  url: string;
  requests: readonly ResendStubRequest[];
  emails: readonly SentEmail[];
  respondNext(response: ScriptedResponse): void;
  hangNext(): void;
  holdNext(response?: ScriptedResponse): HeldRequest;
  close(): Promise<void>;
};

export type ResendStubOptions = {
  now?: () => number;
};

export function resendError(status: number, name: string, message: string): ScriptedResponse {
  return { status, body: { statusCode: status, name, message } };
}

type Override =
  | { kind: "RESPOND"; response: ScriptedResponse }
  | { kind: "HANG" }
  | {
      kind: "HOLD";
      markReceived(): void;
      released: Promise<void>;
      response: ScriptedResponse | undefined;
    };

type LedgerEntry = { email: unknown; firstRequestMs: number } & (
  | { state: "IN_FLIGHT" }
  | { state: "SENT"; id: string }
);

export async function startResendStub(options: ResendStubOptions = {}): Promise<ResendStub> {
  const now = options.now ?? (() => Temporal.Now.instant().epochMilliseconds);
  const requests: ResendStubRequest[] = [];
  const emails: SentEmail[] = [];
  const overrides: Override[] = [];
  const ledger = new Map<string, LedgerEntry>();

  const server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });

  async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const text = await readText(request);
    const idempotencyKey = request.headers["idempotency-key"];
    assert(!Array.isArray(idempotencyKey), "A request carries more than one Idempotency-Key.");
    const body = parseBody(text);
    requests.push({
      method: request.method ?? "GET",
      pathname: requestUrl.pathname,
      authorization: request.headers.authorization,
      userAgent: request.headers["user-agent"],
      idempotencyKey,
      body,
    });

    const refusal = refuse(request, requestUrl, idempotencyKey, body);
    if (refusal !== undefined) {
      respond(response, refusal);
      return;
    }

    const override = overrides.shift();
    if (override?.kind === "RESPOND") {
      respond(response, override.response);
      return;
    }
    if (override?.kind === "HANG") {
      return;
    }
    if (override?.kind === "HOLD" && override.response !== undefined) {
      override.markReceived();
      await override.released;
      respond(response, override.response);
      return;
    }
    respond(response, await send(idempotencyKey, body, override));
  }

  async function send(
    idempotencyKey: string | undefined,
    body: unknown,
    hold: Extract<Override, { kind: "HOLD" }> | undefined,
  ): Promise<ScriptedResponse> {
    const entry = idempotencyKey === undefined ? undefined : ledger.get(idempotencyKey);
    if (entry !== undefined && now() < entry.firstRequestMs + IDEMPOTENCY_KEY_LIFETIME_MS) {
      hold?.markReceived();
      await hold?.released;
      return answerReplay(ledger.get(idempotencyKey ?? "") ?? entry, body);
    }

    const firstRequestMs = now();
    if (idempotencyKey !== undefined) {
      ledger.set(idempotencyKey, { state: "IN_FLIGHT", email: body, firstRequestMs });
    }
    hold?.markReceived();
    await hold?.released;

    const id = crypto.randomUUID();
    if (idempotencyKey !== undefined) {
      ledger.set(idempotencyKey, { state: "SENT", id, email: body, firstRequestMs });
    }
    emails.push({ id, idempotencyKey, email: body });
    return { status: 200, body: { id } };
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(typeof address === "object" && address !== null, "The stub listens on no TCP port.");

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    emails,
    respondNext: (response) => {
      overrides.push({ kind: "RESPOND", response });
    },
    hangNext: () => {
      overrides.push({ kind: "HANG" });
    },
    holdNext: (response) => {
      const received = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      overrides.push({
        kind: "HOLD",
        markReceived: received.resolve,
        released: released.promise,
        response,
      });
      return { received: received.promise, release: released.resolve };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

export async function useResendStub(
  { onTestFinished }: { onTestFinished: (listener: () => Promise<void>) => void },
  options: ResendStubOptions = {},
): Promise<ResendStub> {
  const stub = await startResendStub(options);
  onTestFinished(() => stub.close());
  return stub;
}

function refuse(
  request: http.IncomingMessage,
  requestUrl: URL,
  idempotencyKey: string | undefined,
  body: unknown,
): ScriptedResponse | undefined {
  if (request.method !== "POST" || requestUrl.pathname !== "/emails") {
    return resendError(404, "not_found", "The requested endpoint does not exist.");
  }
  if (request.headers.authorization === undefined) {
    return resendError(401, "missing_api_key", "Missing API key in the authorization header.");
  }
  if (request.headers["user-agent"] === undefined) {
    return resendError(403, "validation_error", "Missing User-Agent header.");
  }
  if (idempotencyKey !== undefined && (idempotencyKey.length < 1 || idempotencyKey.length > 256)) {
    return resendError(400, "invalid_idempotency_key", "The key must be between 1-256 chars.");
  }
  const missingField = ["from", "to", "subject"].find(
    (field) => typeof body !== "object" || body === null || !(field in body),
  );
  if (missingField !== undefined) {
    return resendError(422, "missing_required_field", `Missing \`${missingField}\` field.`);
  }
  return undefined;
}

function answerReplay(entry: LedgerEntry, body: unknown): ScriptedResponse {
  if (entry.state === "IN_FLIGHT") {
    return resendError(
      409,
      "concurrent_idempotent_requests",
      "Same idempotency key used while original request is still in progress.",
    );
  }
  if (!util.isDeepStrictEqual(entry.email, body)) {
    return resendError(
      409,
      "invalid_idempotent_request",
      "This idempotency key has been used with this HTTP method and endpoint within the last 24 hours, but the request body was modified.",
    );
  }
  return { status: 200, body: { id: entry.id } };
}

function respond(response: http.ServerResponse, scripted: ScriptedResponse) {
  if (response.destroyed) {
    return;
  }
  const { status, body, rawBody, headers } = scripted;
  if (rawBody !== undefined) {
    response.writeHead(status, headers).end(rawBody);
    return;
  }
  if (body === undefined) {
    response.writeHead(status, headers).end();
    return;
  }
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function parseBody(text: string): unknown {
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readText(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
