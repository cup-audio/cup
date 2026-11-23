import { createMemoryHistory } from "@tanstack/react-router";
import { waitFor, within } from "@testing-library/dom";
import { userEvent } from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import React from "react";

import { createAppRouter, GlobalProviders } from "#src/app/global-providers.js";
import { storePendingAccountConversion } from "#src/data-fetching/account-conversion-storage.js";
import { accountStory } from "#src/ui-gallery/account-fixtures.jsx";
import { waitWhileHeld } from "#src/ui-gallery/held-responses.js";
import type { Story } from "#src/ui-gallery/story.js";

const router = createAppRouter(createMemoryHistory({ initialEntries: ["/app/"] }));

export function LandingPage(): React.ReactNode {
  return <GlobalProviders router={router} />;
}

const iosAppRouter = createAppRouter(createMemoryHistory({ initialEntries: ["/app/"] }), {
  pageOrigin: "capacitor://localhost",
});

export function LandingPageInIosApp(): React.ReactNode {
  return <GlobalProviders router={iosAppRouter} />;
}

export const SignIn = {
  beforeMount: async () => {
    await router.load();
  },
  component: LandingPage,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const input = await canvas.findByRole("textbox", { name: "URL" });
    await user.clear(input);
    await user.type(input, "https://example.com/article");

    const submit = canvas.getByRole("button", { name: "Listen" });
    await waitFor(() => {
      if (submit.matches(":disabled")) {
        throw new Error("Waiting for conversion submission");
      }
    });
    await user.click(submit);
    await within(document.body).findByRole("dialog", { name: "Sign in" });
  },
} satisfies Story;

export const SignInWithTestAccount = {
  ...SignIn,
  handlers: [
    http.get("/api/auth/config", () =>
      HttpResponse.json({
        supabaseUrl: `${window.location.origin}/__story`,
        publishableKey: "story-key",
        testAccount: { email: "test@cup.test", password: "story-password" },
      }),
    ),
  ],
} satisfies Story;

export const SignInFromLink = {
  beforeMount: SignIn.beforeMount,
  component: LandingPage,
  play: async ({ canvasElement }) => {
    const user = userEvent.setup();
    await user.click(await within(canvasElement).findByRole("link", { name: "Sign in" }));
    await within(document.body).findByRole("dialog", { name: "Sign in" });
  },
} satisfies Story;

export const SignInFromLinkWithTestAccount = {
  ...SignInFromLink,
  handlers: SignInWithTestAccount.handlers,
} satisfies Story;

export const HomeWhileAuthUnavailable = {
  beforeMount: SignIn.beforeMount,
  component: LandingPage,
  handlers: [
    http.get("/api/auth/config", async () => {
      await waitWhileHeld("auth-config");
      return HttpResponse.json(
        { error: { message: "Sign-in is temporarily unavailable." } },
        { status: 503 },
      );
    }),
  ],
} satisfies Story;

export const SignedInHomeWithPendingStart = {
  ...accountStory({
    path: "/",
    handlers: [http.post("/api/account/conversions", () => delay("infinite"))],
  }),
  beforeMount: async () => {
    storePendingAccountConversion({
      sourceUrl: "https://example.com/article",
      idempotencyKey: "0f8fad5b-d9cb-469f-a165-70867728950e",
      submitted: true,
    });
  },
} satisfies Story;
