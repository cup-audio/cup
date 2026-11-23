import { parseResponse, DetailedError as HonoDetailedError } from "hono/client";
import type { ClientResponse } from "hono/client";
import type { IsAny, ScreamingSnakeCase } from "type-fest";

export type ErrorCodeConstants<Code extends string> = {
  readonly [Value in Code as ScreamingSnakeCase<Value>]: Value;
};

export type RpcErrorDetails<Code extends string> = {
  code: Code;
  message: string;
  status: number;
  retryAfter: number;
  traceId: string | undefined;
};

export class RpcError<Code extends string = string> extends Error {
  readonly code: Code;
  readonly status: number;
  readonly retryAfter: number;
  readonly traceId: string | undefined;

  constructor({ code, message, status, retryAfter, traceId }: RpcErrorDetails<Code>) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.traceId = traceId;
  }
}

export function createOkResponseParser<Code extends string>({
  errorCodes,
  fallbackCode,
  createError,
}: {
  errorCodes: Readonly<Record<string, Code>>;
  fallbackCode: NoInfer<Code>;
  createError: (details: RpcErrorDetails<Code>) => RpcError<Code>;
}) {
  const knownCodes: ReadonlySet<string> = new Set<string>(Object.values(errorCodes));
  const isKnownCode = (code: string): code is Code => knownCodes.has(code);

  return async function parseOkResponse<ResponseType extends ClientResponse<unknown>>(
    request: ResponseType | Promise<ResponseType>,
  ): ReturnType<typeof parseResponse<ResponseType>> {
    const response = await request;
    try {
      return await parseResponse(response);
    } catch (error) {
      if (!isParseResponseError(error)) {
        throw error;
      }
      const body = readErrorBody(error);
      throw createError({
        code: body.code !== undefined && isKnownCode(body.code) ? body.code : fallbackCode,
        message: body.message ?? "The request could not be completed.",
        status: response.status,
        retryAfter: Math.max(1, Number(response.headers.get("Retry-After")) || 60),
        traceId: body.traceId,
      });
    }
  };
}

type MapAnyToUnknown<T> = {
  [Key in keyof T]: IsAny<T[Key]> extends true ? unknown : T[Key];
};

type ParseResponseError = MapAnyToUnknown<HonoDetailedError>;

function isParseResponseError(error: unknown): error is ParseResponseError {
  return (
    error instanceof HonoDetailedError ||
    (typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      "message" in error &&
      typeof error.message === "string")
  );
}

function readErrorBody(error: ParseResponseError): {
  code?: string;
  message?: string;
  traceId?: string;
} {
  const detailData =
    typeof error.detail === "object" && error.detail !== null && "data" in error.detail
      ? error.detail.data
      : undefined;
  const body =
    detailData !== null &&
    typeof detailData === "object" &&
    "error" in detailData &&
    typeof detailData.error === "object" &&
    detailData.error !== null
      ? detailData.error
      : {};
  return {
    ...("code" in body && typeof body.code === "string" ? { code: body.code } : {}),
    ...("message" in body && typeof body.message === "string" ? { message: body.message } : {}),
    ...("traceId" in body && typeof body.traceId === "string" ? { traceId: body.traceId } : {}),
  };
}
