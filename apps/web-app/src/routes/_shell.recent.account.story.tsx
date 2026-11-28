import { delay, http, HttpResponse } from "msw";

import { ERROR_CODE } from "@cup/listener-api.client";

import { accountStory } from "#src/ui-gallery/account-fixtures.jsx";

export const ActiveAccount = accountStory({ path: "/recent/account" });
export const LoadingAccount = accountStory({
  path: "/recent/account",
  handlers: [http.get("/api/account", () => delay("infinite"))],
});
export const SetupPending = accountStory({ path: "/recent/account", setupFailure: true });
export const ConfirmDeletion = accountStory({ path: "/recent/account", confirmation: "delete" });
export const RecoveryAvailable = accountStory({
  path: "/recent/account",
  state: "deletion_scheduled",
});
export const ConfirmRecovery = accountStory({
  path: "/recent/account",
  state: "deletion_scheduled",
  confirmation: "restore",
});
export const FinalDeletion = accountStory({ path: "/recent/account", state: "deleting" });

export const SetupRecovers = accountStory({ path: "/recent/account", setupFailure: "once" });
export const ConfirmDeletionPending = accountStory({
  path: "/recent/account",
  confirmation: "delete",
  handlers: [http.post("/api/account/deletion", () => delay("infinite"))],
});
export const ConfirmAppleDeletion = accountStory({
  path: "/recent/account",
  confirmation: "delete",
  acceptedMethods: ["apple"],
  confirmationSignInMethod: null,
});
export const ConfirmAppleDeletionFails = accountStory({
  path: "/recent/account",
  confirmation: "delete",
  acceptedMethods: ["apple"],
  handlers: [
    http.post("/api/account/deletion", () =>
      HttpResponse.json(
        {
          error: {
            code: ERROR_CODE.APPLE_CONFIRMATION_FAILED,
            message: "Apple could not confirm.",
            traceId: "0123456789abcdef0123456789abcdef",
          },
        },
        { status: 503 },
      ),
    ),
  ],
});
export const ConfirmAppleDeletionWithOtherAppleAccount = accountStory({
  path: "/recent/account",
  confirmation: "delete",
  acceptedMethods: ["apple"],
  handlers: [
    http.post("/api/account/deletion", () =>
      HttpResponse.json(
        {
          error: {
            code: ERROR_CODE.APPLE_ACCOUNT_MISMATCH,
            message: "Another Apple Account.",
            traceId: "0123456789abcdef0123456789abcdef",
          },
        },
        { status: 409 },
      ),
    ),
  ],
});
export const ConfirmAppleDeletionSignedInToAnotherAccount = accountStory({
  path: "/recent/account",
  confirmation: "delete",
  acceptedMethods: ["apple"],
  isChallengeForAnotherAccount: true,
});
export const ConfirmAppleDeletionWithoutAppleCredential = accountStory({
  path: "/recent/account",
  confirmation: "delete",
  acceptedMethods: ["apple"],
  handlers: [
    http.post("/api/account/deletion", () =>
      HttpResponse.json(
        {
          error: {
            code: ERROR_CODE.FRESH_AUTH_REQUIRED,
            message: "Confirm deletion with a fresh Apple sign-in.",
            traceId: "0123456789abcdef0123456789abcdef",
          },
        },
        { status: 400 },
      ),
    ),
  ],
});
