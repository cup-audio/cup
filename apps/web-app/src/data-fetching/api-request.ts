import {
  parseOkResponse,
  type AuthenticatedRpcClient,
  type ListenerApiClient,
} from "@cup/listener-api.client";

import { createListenerApiClient } from "#src/api-client.js";
import { getFreshAccountSession, getResourceAccountSession } from "#src/auth/account-session.js";
import { UserFacingError } from "#src/errors.js";

export { ERROR_CODE, RpcError } from "@cup/listener-api.client";

type ApiResponse = Awaited<Parameters<typeof parseOkResponse>[0]>;
type ApiResult<Response extends ApiResponse> = ReturnType<typeof parseOkResponse<Response>>;
type AccountAuth = { subject: string };

export function requestApi<Response extends ApiResponse>(
  auth: "none",
  send: (client: ListenerApiClient) => Promise<Response>,
): ApiResult<Response>;
export function requestApi<Response extends ApiResponse>(
  auth: "optional",
  send: (client: ListenerApiClient | AuthenticatedRpcClient) => Promise<Response>,
): ApiResult<Response>;
export function requestApi<Response extends ApiResponse>(
  auth: AccountAuth,
  send: (client: AuthenticatedRpcClient) => Promise<Response>,
): ApiResult<Response>;
export async function requestApi<Response extends ApiResponse>(
  ...[auth, send]:
    | [auth: "none", send: (client: ListenerApiClient) => Promise<Response>]
    | [
        auth: "optional",
        send: (client: ListenerApiClient | AuthenticatedRpcClient) => Promise<Response>,
      ]
    | [auth: AccountAuth, send: (client: AuthenticatedRpcClient) => Promise<Response>]
): ApiResult<Response> {
  const client = createListenerApiClient();
  if (auth === "none") {
    return parseOkResponse(send(client));
  }

  if (auth === "optional") {
    const session = await getResourceAccountSession();
    return parseOkResponse(
      send(session ? client.createAuthenticatedRpcClient(session.access_token) : client),
    );
  }

  const session = await getFreshAccountSession();
  if (session?.user.id !== auth.subject) {
    throw new UserFacingError({ title: "Sign in to continue." });
  }
  return parseOkResponse(send(client.createAuthenticatedRpcClient(session.access_token)));
}
