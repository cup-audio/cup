import { check } from "@patricktree-stack/utils-ecma/assert.utils";
import { HttpResponse } from "msw";

import type { ErrorResponse } from "@cup/listener-api.routes";

type FailureStatus = 403 | 404 | 500;

const ERROR_OF_STATUS = {
  403: { code: "grant-revoked", message: "This trial was revoked." },
  404: { code: "not-found", message: "Not found." },
  500: { code: "operational-error", message: "The request could not be completed." },
} as const satisfies Record<FailureStatus, Omit<ErrorResponse["error"], "traceId">>;

const holds = new Map<string, { promise: Promise<void>; release: () => void }>();
const failures = new Map<string, FailureStatus>();

export function holdStoryResponses(name: string): void {
  if (holds.has(name)) {
    return;
  }

  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  check.assert(release, "A promise executor runs synchronously.");
  holds.set(name, { promise, release });
}

function releaseStoryResponses(name: string): void {
  holds.get(name)?.release();
  holds.delete(name);
}

function failStoryResponses(name: string, status: FailureStatus): void {
  failures.set(name, status);
}

Object.assign(window, {
  holdResponses: holdStoryResponses,
  releaseResponses: releaseStoryResponses,
  failResponses: failStoryResponses,
});

export async function waitWhileHeld(name: string): Promise<void> {
  await holds.get(name)?.promise;
}

export function readFailedStoryResponse(name: string): HttpResponse<ErrorResponse> | undefined {
  const status = failures.get(name);
  if (status === undefined) {
    return undefined;
  }

  return HttpResponse.json(
    {
      error: {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        ...ERROR_OF_STATUS[status],
      },
    } satisfies ErrorResponse,
    { status },
  );
}
