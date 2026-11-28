import {
  createOkResponseParser,
  RpcError as ApiRpcError,
  type ErrorCodeConstants,
} from "@cup/api-rpc.client";
import type { ErrorCode } from "@cup/operator-api.routes";

export type { ErrorCode } from "@cup/operator-api.routes";

export const ERROR_CODE = {
  ACCOUNT_NOT_ACTIVE: "account-not-active",
  ACCOUNT_NOT_APPLE_LINKED: "account-not-apple-linked",
  ACCOUNT_NOT_FOUND: "account-not-found",
  ACCOUNT_UNAVAILABLE: "account-unavailable",
  ADJUSTMENT_EXCEEDS_AVAILABLE_DURATION: "adjustment-exceeds-available-duration",
  ALLOWANCE_BELOW_USED_DURATION: "allowance-below-used-duration",
  CONVERSION_NOT_ACCOUNT_OWNED: "conversion-not-account-owned",
  CONVERSION_NOT_FOUND: "conversion-not-found",
  EMAIL_MISMATCH: "email-mismatch",
  GRANT_NOT_FOUND: "grant-not-found",
  IDEMPOTENCY_CONFLICT: "idempotency-conflict",
  INVALID_CURSOR: "invalid-cursor",
  INVALID_INPUT: "invalid-input",
  METHOD_NOT_ALLOWED: "method-not-allowed",
  NOT_FOUND: "not-found",
  OPERATIONAL_ERROR: "operational-error",
  OPERATOR_UNAUTHORIZED: "operator-unauthorized",
  REQUEST_TOO_LARGE: "request-too-large",
  UNSUPPORTED_MEDIA_TYPE: "unsupported-media-type",
} as const satisfies ErrorCodeConstants<ErrorCode>;

export class RpcError extends ApiRpcError<ErrorCode> {}

export const parseOkResponse = createOkResponseParser({
  errorCodes: ERROR_CODE,
  fallbackCode: ERROR_CODE.OPERATIONAL_ERROR,
  createError: (details) => new RpcError(details),
});
