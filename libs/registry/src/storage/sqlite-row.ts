import { CupError } from "@cup/errors";

export function requireRow<T>(row: T | undefined): T {
  if (row === undefined) {
    throw new CupError("Required SQLite row is missing");
  }
  return row;
}
