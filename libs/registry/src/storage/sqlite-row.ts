import { CupError } from "@cup/errors";

/** Preserve the fail-fast behavior of storage cursors for required rows. */
export function requireRow<T>(row: T | undefined): T {
  if (row === undefined) {
    throw new CupError("Required SQLite row is missing");
  }
  return row;
}
