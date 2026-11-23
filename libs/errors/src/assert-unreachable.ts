import { CupError } from "#src/cup-error.ts";

export function assertUnreachable(value: never): never {
  throw new CupError(`Unexpected value: ${JSON.stringify(value)}`);
}
