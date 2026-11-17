import { handleTunnelRequest } from "@sentry/cloudflare";

import { CLIENT_IP_HEADERS } from "#src/client-ip-headers.ts";
import {
  InvalidTunnelEnvelopeError,
  readEnvelopeDsn,
  rewriteTunnelEnvelope,
} from "#src/tunnel-envelope.ts";

export type TelemetryTunnelOptions = {
  /** The Worker var `SENTRY_TUNNEL_DSNS`: the DSNs the tunnel forwards to, comma-separated. */
  tunnelDsns: string;
  /**
   * The listener's country, `request.cf.country`, as Cloudflare reports it (`XX` and `T1`
   * included).
   */
  country: string | undefined;
};

/** The headers of Sentry's answer that the client SDK reads, for its rate limits. */
const FORWARDED_RESPONSE_HEADERS = ["Content-Type", "Retry-After", "X-Sentry-Rate-Limits"];

/**
 * Forwards a client SDK's envelope to Sentry, so browser and shell JS telemetry reaches Sentry
 * through Cup's own domain. It forwards only envelopes for a DSN of `tunnelDsns` and answers any
 * other with a 403, so it is no open proxy. Sentry never sees the listener's IP address: the IP
 * headers are removed, and every `event` and `transaction` item carries only the listener's
 * country.
 */
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
    // `handleTunnelRequest` also allows the DSN of the Worker's own Sentry client, so the allowlist
    // is checked here.
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

  // `handleTunnelRequest` would forward the first IP header it finds to Sentry as
  // `X-Sentry-Forwarded-For`.
  const headers = new Headers(request.headers);
  for (const name of CLIENT_IP_HEADERS) {
    headers.delete(name);
  }
  // The tunnel answers a request without a length with a 411.
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
