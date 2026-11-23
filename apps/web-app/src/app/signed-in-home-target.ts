import { hasPendingSharedUrl } from "#src/platform/share-intake.js";

export function signedInHomeTarget(): "/recent" | "/recent/add" {
  return hasPendingSharedUrl() ? "/recent/add" : "/recent";
}
