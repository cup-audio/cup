/*
 * A `node:http` stand-in for Sentry's envelope endpoint, one instance per test on an OS-assigned
 * port. It accepts envelopes for Cup's two projects, records them, and answers as Sentry does, so a
 * test can assert what would have reached Sentry, or that nothing did. It forwards nothing.
 *
 * The envelope format follows Sentry's developer docs as read on 2026-11-16
 * (https://develop.sentry.dev/sdk/data-model/envelopes/): a JSON header line, then items, each a
 * JSON item header line followed by a payload that is `length` bytes long when the item header
 * declares a length and runs to the next newline otherwise. SDKs post envelopes to
 * `/api/{projectId}/envelope/` with the DSN's public key in the `sentry_key` query parameter.
 */

import assert from "node:assert/strict";
import http from "node:http";

/** The stub's numeric project IDs; a DSN from {@link SentryStub.dsn} names one of them. */
export const SENTRY_STUB_PROJECTS = { "cup-worker": "1", "cup-app": "2" } as const;

export type SentryStubProject = keyof typeof SENTRY_STUB_PROJECTS;

export type SentryEnvelopeItem = {
  /** The item header, such as `{ type: "event", length: 123 }`. */
  header: Record<string, unknown>;
  /** The parsed JSON payload; the raw text when it is not JSON. */
  payload: unknown;
};

/** One envelope the stub accepted. */
export type SentryEnvelope = {
  project: SentryStubProject;
  /** The DSN's public key, from the `sentry_key` query parameter or the `X-Sentry-Auth` header. */
  publicKey: string | undefined;
  /** The HTTP request headers, names lowercase, so a test can check what a tunnel forwarded. */
  requestHeaders: Readonly<Record<string, string>>;
  header: Record<string, unknown>;
  items: SentryEnvelopeItem[];
};

/** An error event's payload, with the fields tests read most; the rest passes through. */
export type SentryErrorEvent = {
  event_id?: string;
  level?: string;
  release?: string;
  environment?: string;
  tags?: Record<string, string>;
  user?: Record<string, unknown>;
  request?: { url?: string; headers?: Record<string, string>; query_string?: unknown };
  contexts?: Record<string, Record<string, unknown> | undefined>;
  exception?: {
    values?: Array<{ type?: string; value?: string; mechanism?: Record<string, unknown> }>;
  };
  [key: string]: unknown;
};

/** One streamed span; attributes arrive typed, as `{ value, type }`. */
export type SentryStreamedSpan = {
  name: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  is_segment: boolean;
  status: string;
  attributes: Record<string, { value: unknown; type: string }>;
};

/** One log record (`log` items); attributes arrive typed, as `{ value, type }`. */
export type SentryLog = {
  timestamp: number;
  level: string;
  body: string;
  trace_id?: string;
  severity_number?: number;
  attributes: Record<string, { value: unknown; type: string }>;
};

export type SentryStub = {
  /** The stub's origin on 127.0.0.1. */
  url: string;
  /** A DSN that sends to one of the stub's projects, for `SENTRY_DSN` or a client's `dsn`. */
  dsn(project: SentryStubProject): string;
  /** Every accepted envelope, in arrival order. */
  envelopes: readonly SentryEnvelope[];
  /** The payloads of the `event` items (errors and messages) that reached one project. */
  errorEvents(project: SentryStubProject): SentryErrorEvent[];
  /** The streamed spans (`span` items, `traceLifecycle: "stream"`) that reached one project. */
  spans(project: SentryStubProject): SentryStreamedSpan[];
  /** The log records (`log` items) that reached one project. */
  logs(project: SentryStubProject): SentryLog[];
  /**
   * Resolves once `condition` holds, checking whenever an envelope arrives and at the start.
   * Rejects after `timeoutMs` (default 10 s), naming `description` in the error.
   */
  waitFor(
    description: string,
    condition: () => boolean,
    options?: { timeoutMs?: number },
  ): Promise<void>;
  close(): Promise<void>;
};

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

/** Starts a stub on 127.0.0.1 on a port the OS assigns; the caller closes it. */
export async function startSentryStub(): Promise<SentryStub> {
  const envelopes: SentryEnvelope[] = [];
  const listeners = new Set<() => void>();

  const server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });

  async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readBody(request);
    const project = findProject(requestUrl.pathname);
    if (request.method !== "POST" || project === undefined) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ detail: "Not found" }));
      return;
    }

    const { header, items } = parseEnvelope(body);
    envelopes.push({
      project,
      publicKey: requestUrl.searchParams.get("sentry_key") ?? findAuthKey(request),
      requestHeaders: readRequestHeaders(request),
      header,
      items,
    });
    for (const listener of listeners) {
      listener();
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: header["event_id"] ?? null }));
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(typeof address === "object" && address !== null, "The stub listens on no TCP port.");
  const host = `127.0.0.1:${address.port}`;

  return {
    url: `http://${host}`,
    dsn: (project) => `http://public@${host}/${SENTRY_STUB_PROJECTS[project]}`,
    envelopes,
    errorEvents: (project) =>
      envelopes
        .filter((envelope) => envelope.project === project)
        .flatMap((envelope) => envelope.items)
        .filter((item) => item.header["type"] === "event")
        .map((item) => item.payload)
        .filter(isRecord),
    spans: (project) =>
      envelopes
        .filter((envelope) => envelope.project === project)
        .flatMap((envelope) => envelope.items)
        .filter((item) => item.header["type"] === "span")
        .flatMap((item) => (isSpanContainer(item.payload) ? item.payload.items : [])),
    logs: (project) =>
      envelopes
        .filter((envelope) => envelope.project === project)
        .flatMap((envelope) => envelope.items)
        .filter((item) => item.header["type"] === "log")
        .flatMap((item) => (isLogContainer(item.payload) ? item.payload.items : [])),
    waitFor: (description, condition, { timeoutMs = DEFAULT_WAIT_TIMEOUT_MS } = {}) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (condition()) {
            cleanUp();
            resolve();
          }
        };
        const timeout = setTimeout(() => {
          cleanUp();
          reject(
            new Error(`The Sentry stub did not receive ${description} within ${timeoutMs} ms.`),
          );
        }, timeoutMs);
        const cleanUp = () => {
          clearTimeout(timeout);
          listeners.delete(check);
        };
        listeners.add(check);
        check();
      }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}

/**
 * Starts a stub and closes it when the test finishes. Pass `onTestFinished` from the test's own
 * context, so that concurrent tests each close their own stub.
 */
export async function useSentryStub({
  onTestFinished,
}: {
  onTestFinished: (listener: () => Promise<void>) => void;
}): Promise<SentryStub> {
  const stub = await startSentryStub();
  onTestFinished(() => stub.close());
  return stub;
}

function findProject(pathname: string): SentryStubProject | undefined {
  const projectId = /^\/api\/(\d+)\/envelope\/?$/.exec(pathname)?.[1];
  return Object.keys(SENTRY_STUB_PROJECTS)
    .filter((name) => isStubProject(name))
    .find((project) => SENTRY_STUB_PROJECTS[project] === projectId);
}

function isStubProject(name: string): name is SentryStubProject {
  return Object.hasOwn(SENTRY_STUB_PROJECTS, name);
}

function findAuthKey(request: http.IncomingMessage): string | undefined {
  const auth = request.headers["x-sentry-auth"];
  return typeof auth === "string" ? /sentry_key=([^,\s]+)/.exec(auth)?.[1] : undefined;
}

function readRequestHeaders(request: http.IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(", ") : (value ?? ""),
    ]),
  );
}

function parseEnvelope(body: Buffer): Pick<SentryEnvelope, "header" | "items"> {
  let offset = 0;
  const readLine = (): Buffer => {
    const end = body.indexOf(0x0a, offset);
    const line = body.subarray(offset, end === -1 ? body.length : end);
    offset = end === -1 ? body.length : end + 1;
    return line;
  };

  const header = parseJsonObject(readLine().toString("utf8"));
  const items: SentryEnvelopeItem[] = [];
  while (offset < body.length) {
    const itemHeaderLine = readLine().toString("utf8");
    if (itemHeaderLine.trim() === "") {
      continue;
    }
    const itemHeader = parseJsonObject(itemHeaderLine);
    const length = itemHeader["length"];
    let payload: Buffer;
    if (typeof length === "number") {
      payload = body.subarray(offset, offset + length);
      // A newline may follow a payload of declared length.
      offset += length + (body[offset + length] === 0x0a ? 1 : 0);
    } else {
      payload = readLine();
    }
    items.push({ header: itemHeader, payload: parsePayload(payload.toString("utf8")) });
  }
  return { header, items };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert(isRecord(value), `An envelope header is not a JSON object: ${text}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `span` item's payload: the spans in `items`; the stub trusts their shape, as Sentry sent it. */
function isSpanContainer(value: unknown): value is { items: SentryStreamedSpan[] } {
  return isRecord(value) && Array.isArray(value["items"]);
}

function isLogContainer(value: unknown): value is { items: SentryLog[] } {
  return isRecord(value) && Array.isArray(value["items"]);
}

function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}
