import {
  ERROR_CODE,
  parseOkResponse,
  RpcError,
  type AuthenticatedRpcClient,
  type ListenerApiClient,
} from "@cup/listener-api.client";

import { createListenerApiClient } from "#src/api-client.js";
import { refuseAccountSession } from "#src/auth/account-admission.js";
import { getFreshAccountSession, getResourceAccountSession } from "#src/auth/account-session.js";
import { UserFacingError } from "#src/errors.js";

/**
 * Every unsuccessful API response rejects with `RpcError`, see {@link requestApi}; compare its
 * `code` with `ERROR_CODE`.
 */
export { ERROR_CODE, RpcError } from "@cup/listener-api.client";

type ApiResponse = Awaited<Parameters<typeof parseOkResponse>[0]>;
type ApiResult<Response extends ApiResponse> = ReturnType<typeof parseOkResponse<Response>>;
type AccountAuth = { subject: string };

/**
 * Sends one API request with a freshly resolved account token and returns its parsed payload. Grant
 * sessions travel as cookies independently of the account authorization chosen here:
 *
 * - `"none"`: no account token.
 * - `"optional"`: the signed-in account's token if there is one, e.g. for an article that a
 *   conversion grant or an account may own.
 * - `{ subject }`: the account the request was issued for must still be signed in; otherwise the
 *   request is rejected before dispatch.
 *
 * Unsuccessful responses reject with `RpcError`; a missing or changed required account rejects with
 * a plain `Error` before the request is sent. A request refused with `account-not-admitted`,
 * because the signed-in identity is off the account allowlist, signs out first
 * (`refuseAccountSession`); an `"optional"` request is then sent again without the account token.
 */
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
    if (!session) {
      return parseOkResponse(send(client));
    }
    try {
      return await parseOkResponse(send(client.createAuthenticatedRpcClient(session.access_token)));
    } catch (error) {
      if (!isNotAdmitted(error)) {
        throw error;
      }
      await signOutRefusedSession({ shouldGoHome: false });
      return parseOkResponse(send(client));
    }
  }

  const session = await getFreshAccountSession();
  if (session?.user.id !== auth.subject) {
    throw new UserFacingError({ title: "Sign in to continue." });
  }
  try {
    return await parseOkResponse(send(client.createAuthenticatedRpcClient(session.access_token)));
  } catch (error) {
    if (isNotAdmitted(error)) {
      await signOutRefusedSession({ shouldGoHome: true });
    }
    throw error;
  }
}

function isNotAdmitted(error: unknown) {
  return error instanceof RpcError && error.code === ERROR_CODE.ACCOUNT_NOT_ADMITTED;
}

/** The sign-out reports its own failure in the auth state; the request keeps its own outcome. */
async function signOutRefusedSession(options: { shouldGoHome: boolean }) {
  await refuseAccountSession(options).catch(() => {});
}
