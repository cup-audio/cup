export type ExceptionChain = {
  rootCause: {
    type: string;
    message?: string;
    stacktrace?: string;
  };
  wrapperTypes: string[];
};

export function isCupError(error: Error): boolean {
  return "cupError" in error && error.cupError === true;
}

export function findErrorType(error: Error): string {
  return error.constructor.name || error.name;
}

export function findErrorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let current = error; current instanceof Error && !chain.includes(current);) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

export function describeExceptionChain(error: unknown): ExceptionChain {
  const chain = findErrorChain(error);
  const innermostError = chain.at(-1);
  if (innermostError === undefined) {
    return { rootCause: { type: typeof error }, wrapperTypes: [] };
  }

  const cause = innermostError.cause;
  if (cause !== undefined && !(cause instanceof Error)) {
    return { rootCause: { type: typeof cause }, wrapperTypes: chain.map(findErrorType) };
  }
  return {
    rootCause: describeError(innermostError),
    wrapperTypes: chain.slice(0, -1).map(findErrorType),
  };
}

function describeError(error: Error): ExceptionChain["rootCause"] {
  const type = findErrorType(error);
  if (isCupError(error)) {
    return {
      type,
      message: error.message,
      ...(error.stack === undefined ? {} : { stacktrace: error.stack }),
    };
  }
  if (error.stack === undefined) {
    return { type };
  }
  const frames = error.stack.split("\n").filter((line) => /^\s+at /.test(line));
  return { type, stacktrace: [type, ...frames].join("\n") };
}
