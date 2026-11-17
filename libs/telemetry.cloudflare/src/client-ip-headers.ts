/**
 * The request headers that carry the listener's IP address, in lower case: the ones Cloudflare
 * sets, and `X-Vercel-Forwarded-For`, which Sentry's `handleTunnelRequest` also reads. Telemetry
 * sends none of them.
 */
export const CLIENT_IP_HEADERS: readonly string[] = [
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "true-client-ip",
  "x-forwarded-for",
  "x-real-ip",
  "x-vercel-forwarded-for",
];
