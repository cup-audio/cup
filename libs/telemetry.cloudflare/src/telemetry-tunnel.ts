import { handleTunnelRequest } from "@sentry/cloudflare";

import { CLIENT_IP_HEADERS } from "#src/client-ip-headers.ts";
import {
  InvalidTunnelEnvelopeError,
  readEnvelopeDsn,
  rewriteTunnelEnvelope,
} from "#src/tunnel-envelope.ts";

export type TelemetryTunnelOptions = {
  tunnelDsns: string;
  country: string | undefined;
};

const FORWARDED_RESPONSE_HEADERS = ["Content-Type", "Retry-After", "X-Sentry-Rate-Limits"];

export async function handleTelemetryTunnelRequest(
  request: Request,
  { tunnelDsns, country }: TelemetryTunnelOptions,
): Promise<Response> {
  const allowedDsns = tunnelDsns
    .split(",")
    .map((dsn) => dsn.trim())
    .filter((dsn) => dsn !== "");
  const envelope = new Uint8Array(await request.arrayBuffer());

  let rewrittenEnvelope: Uint8Array<ArrayBuffer>;
  try {
    const dsn = readEnvelopeDsn(envelope);
    if (dsn === undefined || !allowedDsns.includes(dsn)) {
      return new Response("DSN not allowed", { status: 403 });
    }
    rewrittenEnvelope = rewriteTunnelEnvelope(envelope, country);
  } catch (error) {
    if (error instanceof InvalidTunnelEnvelopeError) {
      return new Response("Invalid envelope", { status: 400 });
    }
    throw error;
  }

  const headers = new Headers(request.headers);
  for (const name of CLIENT_IP_HEADERS) {
    headers.delete(name);
  }
  headers.set("Content-Length", String(rewrittenEnvelope.length));
  const sentryResponse = await handleTunnelRequest(
    new Request(request.url, { method: "POST", headers, body: rewrittenEnvelope }),
    { allowedDsns },
  );

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = sentryResponse.headers.get(name);
    if (value !== null) {
      responseHeaders.set(name, value);
    }
  }
  return new Response(sentryResponse.body, {
    status: sentryResponse.status,
    headers: responseHeaders,
  });
}
