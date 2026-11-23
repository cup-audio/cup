import { createFileRoute, type ErrorComponentProps } from "@tanstack/react-router";
import React from "react";

import { AccountLoadError, AccountLoading } from "#src/app/components/account-load-states.js";
import { AccountSettings } from "#src/app/components/account-settings.js";
import { CrashReportsSetting } from "#src/app/components/crash-reports-setting.js";
import { PageTitle } from "#src/app/components/page-title.js";
import { DSDialog } from "#src/app/design-system/dialog.js";
import { useCloseRecentsDialog } from "#src/app/use-close-recents-dialog.js";
import { useAccountSession } from "#src/auth/hooks.js";
import { useIsAccountConfirmationPending } from "#src/data-fetching/account-confirmation.js";
import { accountQuery } from "#src/data-fetching/account.js";
import { hasCrashReportsSwitch } from "#src/platform/crash-reporting.js";

export const Route = createFileRoute("/_shell/recent/account")({
  component: AccountDialog,
  loader: async ({ context }) => {
    await context.queryClient.query({ ...accountQuery(context.subject), staleTime: "static" });
  },
  pendingComponent: () => (
    <AccountDialogFrame>
      <AccountLoading />
    </AccountDialogFrame>
  ),
  errorComponent: ({ error }: ErrorComponentProps) => (
    <AccountDialogFrame>
      <AccountLoadError error={error} />
    </AccountDialogFrame>
  ),
});

function AccountDialog(): React.ReactNode {
  const session = useAccountSession();

  return (
    <AccountDialogFrame>
      {session && (
        <AccountSettings
          key={session.user.id}
          subject={session.user.id}
          email={session.user.email}
          purpose="settings"
        />
      )}
      {hasCrashReportsSwitch() && <CrashReportsSetting />}
    </AccountDialogFrame>
  );
}

function AccountDialogFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  const close = useCloseRecentsDialog(Route.id);
  const isConfirmationPending = useIsAccountConfirmationPending();
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);

  return (
    <>
      <PageTitle name="Account" />
      <DSDialog
        open
        onOpenChange={(open) => {
          if (!open && !isConfirmationPending) {
            close();
          }
        }}
        initialFocus={closeButtonRef}
        finalFocus={undefined}
        title={<>Account settings</>}
        cancelButtonText={<>Close</>}
        cancelButtonDisabled={isConfirmationPending}
        cancelButtonRef={closeButtonRef}
      >
        {children}
      </DSDialog>
    </>
  );
}
