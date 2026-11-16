import { captureException } from "@sentry/core";

import { CupError } from "@cup/errors";
import { TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

/** A conversion Workflow instance that an owner's alarm found errored or terminated. */
export type StoppedWorkflow =
  | { kind: "preparation"; conversionId: string }
  | { kind: "audio-segment"; conversionId: string; sequence: number };

class StoppedWorkflowError extends CupError {
  override name = "StoppedWorkflowError";
}

/**
 * Captures a Workflow instance that stopped without recording its own failure, such as one the
 * platform terminated or one that died outside its failure handling, when the owner's alarm turns
 * it into a failed conversion outcome or a finally failed segment. Returns the event ID, which a
 * trial conversion stores as its `diagnosticReference`. Call it in the alarm iteration's conversion
 * scope, which supplies the conversion and owner tags.
 */
export function captureStoppedWorkflow(workflow: StoppedWorkflow): string {
  // The conversion ID and sequence keep Sentry's Dedupe integration from dropping the next stopped
  // instance's event as a repeat of this one.
  const error =
    workflow.kind === "preparation"
      ? new StoppedWorkflowError(
          `The preparation Workflow of conversion ${workflow.conversionId} stopped`,
        )
      : new StoppedWorkflowError(
          `The Workflow of audio segment ${workflow.sequence} of conversion ${workflow.conversionId} stopped`,
        );
  return captureException(error, {
    tags: {
      [TELEMETRY_ATTRIBUTES.CONVERSION_FAILURE_CATEGORY]:
        workflow.kind === "preparation" ? "workflow-platform" : "segment",
    },
  });
}
