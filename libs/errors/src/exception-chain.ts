/*
 * A caught error is reported by its root cause, the error that actually went wrong, plus the types
 * of the errors that wrap it. Only Cup's own errors keep their messages: Cup writes those itself,
 * while a foreign error's message can embed data that must never reach telemetry, such as the SQL
 * parameters in a Drizzle query error.
 */

/** The innermost value of a cause chain and the types of the errors that wrap it. */
export type ExceptionChain = {
  rootCause: {
    type: string;
    /** Only for Cup's own errors. */
    message?: string;
    /** A foreign error's stack keeps its frames and loses the message in its first line. */
    stacktrace?: string;
  };
  /** The wrapper types, outermost to innermost; empty for an error without a cause. */
  wrapperTypes: string[];
};

/**
 * Whether an error is Cup's own: a `CupError`, or an error a Durable Object RPC call rebuilt from
 * one, which keeps the brand as an own property. Every other error, a plain `Error` included, is
 * foreign.
 */
export function isCupError(error: Error): boolean {
  return "cupError" in error && error.cupError === true;
}

/**
 * The error type Cup reports: the constructor's name, because a class that does not set `name`,
 * such as Drizzle's `DrizzleQueryError`, would otherwise read as `Error`.
 */
export function findErrorType(error: Error): string {
  return error.constructor.name || error.name;
}

/**
 * An error and its causes, outermost first. A chain that loops back on itself ends at the last
 * error before the repetition; a cause that is not an `Error` ends it and is not included.
 */
export function findErrorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let current = error; current instanceof Error && !chain.includes(current);) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

/** Describes a caught value by its root cause and wrapper types, keeping only Cup's messages. */
export function describeExceptionChain(error: unknown): ExceptionChain {
  const chain = findErrorChain(error);
  const innermostError = chain.at(-1);
  if (innermostError === undefined) {
    return { rootCause: { type: typeof error }, wrapperTypes: [] };
  }

  // A cause that is not an `Error`, such as a thrown string, is the root cause itself.
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
  // A V8 stack starts with `name: message`, which may span several lines, before its frames.
  const frames = error.stack.split("\n").filter((line) => /^\s+at /.test(line));
  return { type, stacktrace: [type, ...frames].join("\n") };
}
