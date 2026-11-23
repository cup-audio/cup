import { RpcError } from "@cup/listener-api.client";

export type ErrorCopy = { title: string; detail: string | undefined };

type ErrorDescription = ErrorCopy & {
  isRetryable: boolean;
  reference: string | undefined;
};

export type DescribeApiRefusal = (error: RpcError) => ErrorCopy;

export class UserFacingError extends Error {
  readonly title: string;
  readonly detail: string | undefined;

  constructor({ title, detail, cause }: { title: string; detail?: string; cause?: unknown }) {
    super(detail === undefined ? title : `${title} ${detail}`, { cause });
    this.name = "UserFacingError";
    this.title = title;
    this.detail = detail;
  }
}

export class SignInCancelledError extends UserFacingError {
  constructor({ cause }: { cause?: unknown } = {}) {
    super({ title: "Google sign-in was cancelled.", cause });
    this.name = "SignInCancelledError";
  }
}

export function describeError(
  error: unknown,
  fallbackTitle: string,
  describeApiRefusal?: DescribeApiRefusal,
): ErrorDescription {
  if (error instanceof UserFacingError) {
    return { title: error.title, detail: error.detail, isRetryable: false, reference: undefined };
  }

  if (error instanceof RpcError && error.status < 500) {
    if (error.status === 429) {
      return {
        title: fallbackTitle,
        detail: error.message,
        isRetryable: true,
        reference: undefined,
      };
    }

    const refusal = describeApiRefusal?.(error) ?? { title: fallbackTitle, detail: error.message };
    return { ...refusal, isRetryable: false, reference: undefined };
  }

  return {
    title: fallbackTitle,
    detail: undefined,
    isRetryable: true,
    reference: error instanceof RpcError ? error.traceId : undefined,
  };
}

export function summarizeError(error: unknown, fallbackTitle: string): string {
  const description = describeError(error, fallbackTitle);
  return description.detail ?? description.title;
}
