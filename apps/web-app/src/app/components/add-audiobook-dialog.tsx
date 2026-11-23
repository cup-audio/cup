import { css } from "@linaria/core";
import React from "react";

import { SignInButtons } from "#src/app/components/sign-in-dialog.js";
import { SourceUrlForm, wavyRuleFormStyles } from "#src/app/components/source-url-form.js";
import { ArrowRightIcon } from "#src/app/design-system/icons.js";
import { DSSheet } from "#src/app/design-system/sheet.js";
import { textStyles } from "#src/app/design-system/text-styles.js";
import { useAccountConversionSubmission } from "#src/app/use-cases/account-conversions.js";
import { composeClassnames } from "#src/app/utils.js";

export function AddAudiobookDialog({ onClose }: { onClose: () => void }): React.ReactNode {
  const [open, setOpen] = React.useState(true);
  const submission = useAccountConversionSubmission({
    requestStorage: "memory",
    onStarted: async () => setOpen(false),
  });
  return (
    <DSSheet
      open={open}
      onOpenChange={setOpen}
      onClosed={onClose}
      finalFocus={undefined}
      title={<>Add a track</>}
      closeButtonDisabled={submission.signIn.isPending}
    >
      <div
        className={composeClassnames(
          textStyles.paragraph,
          css`
            display: grid;
            gap: calc(2 * var(--spacing-base));

            /* the design sets the field 58 px below the title row */
            padding-block-start: 58px;
          `,
        )}
      >
        <SourceUrlForm
          initialSourceUrl={submission.initialSourceUrl}
          shouldReceiveSharedUrl={open}
          isPending={submission.isPending}
          retryIn={submission.retryIn}
          error={submission.isSignInOpen ? undefined : submission.error}
          errorFallbackMessage="The track could not be added."
          onSubmit={submission.submit}
          placeholder="Paste website link (https://...)"
          submitLabel="Add"
          submittingLabel="Adding…"
          submitIcon={<ArrowRightIcon />}
          sx={{
            form: css`
              display: grid;
              gap: 23px;
            `,
            input: wavyRuleFormStyles.input,
            submitButton: wavyRuleFormStyles.submitButton,
          }}
        />

        {submission.isSignInOpen ? (
          <section aria-label="Sign in">
            <p>Sign in to listen.</p>
            <SignInButtons
              signInMethods={submission.signInMethods}
              pendingMethod={submission.signIn.isPending ? submission.signIn.variables : undefined}
              onSignIn={(method) => submission.signIn.mutate(method)}
            />
            {submission.signIn.error && <p role="alert">{submission.signIn.error.message}</p>}
          </section>
        ) : null}
      </div>
    </DSSheet>
  );
}
