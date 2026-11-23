import { isDevelopmentOperatorUrl, LOCAL_OPERATOR_ACCESS_TOKEN } from "@cup/operator-api.routes";

export function isDevelopmentOperatorRequest(request: Request): boolean {
  return (
    isDevelopmentOperatorUrl(new URL(request.url)) &&
    request.headers.get("Cf-Access-Token") === LOCAL_OPERATOR_ACCESS_TOKEN
  );
}
