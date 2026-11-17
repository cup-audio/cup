/**
 * The path of the telemetry tunnel on the Worker, at the API origin and outside `/api/*`: the
 * client SDKs send their envelopes to it, and the API server routes it to the tunnel.
 */
export const TELEMETRY_TUNNEL_PATH = "/_/e";
