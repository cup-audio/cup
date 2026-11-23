import type { GrantState } from "@cup/conversion-grants";
import { assertUnreachable } from "@cup/errors";
import type { ErrorCode as ListenerErrorCode } from "@cup/listener-api.routes";
import type { ErrorCode as OperatorErrorCode } from "@cup/operator-api.routes";

type ErrorCode = ListenerErrorCode | OperatorErrorCode;

export function accountAuthError(
  result: "unauthorized" | "unavailable" | "blocked" | "rate-limited",
  traceId: string,
  retryAfter = 3600,
) {
  if (result === "rate-limited") {
    return jsonError(
      traceId,
      "rate-limited",
      "Too many new accounts from this connection. Please try later.",
      429,
      { "Retry-After": String(retryAfter) },
    );
  }
  if (result === "unauthorized") {
    return jsonError(traceId, "account-session-required", "Sign in to continue.", 401);
  }
  if (result === "blocked") {
    return jsonError(traceId, "account-blocked", "Account access is blocked.", 403);
  }
  if (result === "unavailable") {
    return jsonError(
      traceId,
      "account-setup-pending",
      "Account setup is temporarily unavailable. Please retry.",
      503,
    );
  }
  return assertUnreachable(result);
}

export function requireAccessibleGrantState(
  state: GrantState,
  traceId: string,
): Response | undefined {
  if (state === "expired" || state === "revoked") {
    return jsonError(
      traceId,
      `grant-${state}`,
      state === "expired"
        ? "This trial has expired. Its audiobooks are no longer accessible."
        : "This trial has been revoked. Its audiobooks are no longer accessible.",
      403,
    );
  }
  return undefined;
}

function createErrorBody(traceId: string, code: ErrorCode, message: string) {
  return { error: { code, message, traceId } };
}

export function jsonError(
  traceId: string,
  code: ErrorCode,
  message: string,
  status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 416 | 429 | 500 | 503,
  headers?: HeadersInit,
): Response {
  return Response.json(createErrorBody(traceId, code, message), {
    status,
    ...(headers === undefined ? {} : { headers }),
  });
}
