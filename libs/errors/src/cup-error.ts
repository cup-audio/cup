/**
 * The base class of every error Cup throws in Worker code. Telemetry keeps the message only of
 * these errors: Cup writes them itself, while a dependency's error, even a plain `Error`, can embed
 * data that must never reach telemetry, such as the SQL parameters in a Drizzle query error.
 */
export class CupError extends Error {
  /**
   * The brand that `isCupError` checks. It is an own enumerable property because a Durable Object
   * RPC call rebuilds a thrown error as a plain `Error` that keeps only its name, message, stack,
   * cause and own properties.
   */
  readonly cupError = true;
}
