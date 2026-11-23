import { ACCOUNT_CONFIRMATION_STORAGE_KEY } from "#src/data-fetching/account-confirmation-storage.ts";
import { expect, test, VISUAL_TAG } from "#src/test-utils/component-test.ts";

for (const state of [
  {
    story: "routes/_shell.recent.account/ActiveAccount",
    text: "Delete account…",
    name: "active-account",
  },
  {
    story: "routes/_shell.recent.account/SetupPending",
    text: "Retry setup",
    name: "setup-pending",
  },
  {
    story: "routes/_shell.recent.account/ConfirmDeletion",
    text: "Schedule deletion",
    name: "confirm-deletion",
  },
  {
    story: "routes/_shell.recent.account/ConfirmAppleDeletion",
    text: "Can't sign in with Apple? Email support@cup.audio.",
    name: "confirm-apple-deletion",
  },
  {
    story: "routes/_shell.recent.account/RecoveryAvailable",
    text: "Restore account…",
    name: "recovery-available",
  },
  {
    story: "routes/_shell.recent.account/ConfirmRecovery",
    text: "Confirm recovery",
    name: "confirm-recovery",
  },
  {
    story: "routes/_shell.recent.account/FinalDeletion",
    text: "Restore account…",
    name: "final-deletion",
  },
]) {
  test(`renders ${state.name}`, { tag: VISUAL_TAG }, async ({ mount, page }) => {
    await mount(state.story);
    const dialog = page.getByRole("dialog", { name: "Account settings" });
    await expect(dialog.getByText(state.text, { exact: true })).toBeVisible();
    if (state.name === "final-deletion") {
      await expect(dialog.getByRole("button", { name: "Restore account…" })).toBeDisabled();
    }
    await expect(page).toHaveScreenshot(`${state.name}.png`);
  });
}

test("closing the account dialog opened from Recents returns to Recents", async ({
  mount,
  page,
}) => {
  const component = await mount("routes/_shell.recent/EmptyRecents");
  await component.getByRole("link", { name: "Account", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Account settings" });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(component.getByRole("heading", { name: "Recent", exact: true })).toBeVisible();
  await component.getByRole("link", { name: "Account", exact: true }).click();
  await expect(dialog).toBeVisible();
});

test("closing the account dialog opened by a direct link leads to Recents", async ({
  mount,
  page,
}) => {
  const component = await mount("routes/_shell.recent.account/ActiveAccount");
  const dialog = page.getByRole("dialog", { name: "Account settings" });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(component.getByRole("heading", { name: "Recent", exact: true })).toBeVisible();
});

test("canceling deletion confirmation removes the pending operation", async ({ mount, page }) => {
  await mount("routes/_shell.recent.account/ConfirmDeletion");
  const dialog = page.getByRole("dialog", { name: "Account settings" });
  await expect(dialog.getByRole("region", { name: "Confirm account change" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Confirm account change" })).not.toBeVisible();
  await expect(dialog).toBeVisible();
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), ACCOUNT_CONFIRMATION_STORAGE_KEY),
  ).toBeNull();
});

test("account setup query failure can be retried", async ({ mount, page }) => {
  await mount("routes/_shell.recent.account/SetupRecovers");
  const dialog = page.getByRole("dialog", { name: "Account settings" });
  await dialog.getByRole("button", { name: "Retry setup" }).click();
  await expect(dialog.getByRole("button", { name: "Delete account…" })).toBeVisible();
});

test("confirmation cannot use a challenge that was cleared after the dialog rendered", async ({
  mount,
  page,
}) => {
  await mount("routes/_shell.recent.account/ConfirmDeletion");
  const dialog = page.getByRole("dialog", { name: "Account settings" });
  await expect(dialog.getByRole("button", { name: "Schedule deletion" })).toBeVisible();
  await page.evaluate((key) => sessionStorage.removeItem(key), ACCOUNT_CONFIRMATION_STORAGE_KEY);
  let deletionRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/account/deletion"
    ) {
      deletionRequests += 1;
    }
  });
  await dialog.getByRole("button", { name: "Schedule deletion" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Use the same Google account that requested confirmation.",
  );
  expect(deletionRequests).toBe(0);
});

test("the account dialog stays open while a confirmation step runs", async ({ mount, page }) => {
  await mount("routes/_shell.recent.account/ConfirmDeletionPending");
  const dialog = page.getByRole("dialog", { name: "Account settings" });
  await dialog.getByRole("button", { name: "Schedule deletion" }).click();
  await expect(dialog.getByText("Working…")).toBeVisible();

  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
});

test("the account dialog opens with focus on Close, not on a step that changes the account", async ({
  mount,
  page,
}) => {
  await mount("routes/_shell.recent.account/ConfirmDeletion");
  const dialog = page.getByRole("dialog", { name: "Account settings" });
  await expect(dialog.getByRole("button", { name: "Schedule deletion" })).toBeVisible();

  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
});

test("the account still loading is marked as a loading state", async ({ mount, page }) => {
  await mount("routes/_shell.recent.account/LoadingAccount");

  const dialog = page.getByRole("dialog", { name: "Account settings" });
  await expect(dialog.getByText("Loading account…")).toHaveAttribute("data-loading-state", "");
});

test("in the browser, the account dialog has no crash reports switch", async ({ mount, page }) => {
  await mount("routes/_shell.recent.account/ActiveAccount");
  const dialog = page.getByRole("dialog", { name: "Account settings" });
  await expect(dialog.getByRole("button", { name: "Delete account…" })).toBeVisible();

  await expect(dialog.getByRole("switch")).toHaveCount(0);
});

test("an Apple-linked deletion is confirmed with one Continue with Apple button", async ({
  mount,
  page,
}) => {
  await mount("routes/_shell.recent.account/ConfirmAppleDeletion");
  const confirmation = page
    .getByRole("dialog", { name: "Account settings" })
    .getByRole("region", { name: "Confirm account change" });

  await expect(confirmation.getByRole("button")).toHaveText(["Continue with Apple", "Cancel"]);
  await expect(confirmation.getByRole("link", { name: "support@cup.audio" })).toHaveAttribute(
    "href",
    "mailto:support@cup.audio",
  );
});

test("an Apple-linked deletion sends the Apple sign-in's refresh token", async ({
  mount,
  page,
}) => {
  await mount("routes/_shell.recent.account/ConfirmAppleDeletionFails");
  const dialog = page.getByRole("dialog", { name: "Account settings" });
  const deletion = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/api/account/deletion",
  );

  await dialog.getByRole("button", { name: "Schedule deletion" }).click();

  expect((await deletion).postDataJSON()).toMatchObject({
    providerCredential: { provider: "apple", refreshToken: "story-apple-refresh-token" },
  });
});

for (const failure of [
  {
    story: "routes/_shell.recent.account/ConfirmAppleDeletionFails",
    message:
      "Apple couldn't confirm the deletion. Your account is still active, and nothing will be deleted. Try again.",
  },
  {
    story: "routes/_shell.recent.account/ConfirmAppleDeletionWithOtherAppleAccount",
    message: "Use the Apple Account linked to this Cup account.",
  },
]) {
  test(`an Apple deletion that fails says "${failure.message}" and starts over`, async ({
    mount,
    page,
  }) => {
    await mount(failure.story);
    const dialog = page.getByRole("dialog", { name: "Account settings" });

    await dialog.getByRole("button", { name: "Schedule deletion" }).click();

    await expect(dialog.getByRole("alert")).toHaveText(failure.message);
    await expect(dialog.getByRole("region", { name: "Confirm account change" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Delete account…" })).toBeEnabled();
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), ACCOUNT_CONFIRMATION_STORAGE_KEY),
    ).toBeNull();
  });
}

test("an Apple confirmation that signed in to another Cup account asks for the Apple Account linked to this one", async ({
  mount,
  page,
}) => {
  await mount("routes/_shell.recent.account/ConfirmAppleDeletionSignedInToAnotherAccount");
  const dialog = page.getByRole("dialog", { name: "Account settings" });

  await expect(dialog.getByRole("alert")).toHaveText(
    "Use the Apple Account linked to this Cup account.",
  );
  await expect(dialog.getByRole("button", { name: "Schedule deletion" })).toBeDisabled();
  await expect(dialog.getByText(/Google/)).toHaveCount(0);
});

test("an Apple deletion the server refuses for a missing Apple credential shows Apple's failure and the support address", async ({
  mount,
  page,
}) => {
  await mount("routes/_shell.recent.account/ConfirmAppleDeletionWithoutAppleCredential");
  const dialog = page.getByRole("dialog", { name: "Account settings" });

  await dialog.getByRole("button", { name: "Schedule deletion" }).click();

  await expect(dialog.getByRole("alert")).toHaveText(
    "Apple couldn't confirm the deletion. Your account is still active, and nothing will be deleted. Try again. Can't sign in with Apple? Email support@cup.audio.",
  );
  await expect(dialog.getByRole("button", { name: "Delete account…" })).toBeEnabled();
});
