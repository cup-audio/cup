import { createFileRoute, redirect } from "@tanstack/react-router";
import React from "react";

import { ConversionShell } from "#src/app/components/conversion-shell.jsx";
import { PageSkeleton } from "#src/app/components/page-skeleton.js";
import { StartConversionForm } from "#src/app/components/start-conversion-form.js";
import { signedInHomeTarget } from "#src/app/signed-in-home-target.js";
import { settleAccountSession } from "#src/auth/account-session.js";
import { readPendingAccountConversion } from "#src/data-fetching/account-conversion-storage.js";

export const Route = createFileRoute("/")({
  component: IndexPage,
  beforeLoad: async () => {
    const session = await settleAccountSession().catch(() => null);
    if (session && readPendingAccountConversion() === null) {
      throw redirect({ to: signedInHomeTarget(), replace: true });
    }
  },
  pendingComponent: () => <PageSkeleton label="Loading" />,
});

function IndexPage(): React.JSX.Element {
  return (
    <ConversionShell>
      <StartConversionForm mode="account" />
    </ConversionShell>
  );
}
