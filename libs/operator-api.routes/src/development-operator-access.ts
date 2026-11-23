export const LOCAL_OPERATOR_ACCESS_TOKEN = "create-audiobook-from-url-local-operator";
const TRUSTED_TAILNET_DNS_SUFFIX = ".oberhasli-universe.ts.net";

export function isDevelopmentOperatorUrl(url: URL): boolean {
  return isLoopbackOperatorUrl(url) || url.hostname.endsWith(TRUSTED_TAILNET_DNS_SUFFIX);
}

export function isLoopbackOperatorUrl(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}
