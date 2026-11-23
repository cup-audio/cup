import { captureException } from "@sentry/core";

import type { ConversionFailureCategory } from "@cup/conversion-contracts";
import { CupError } from "@cup/errors";
import { SEGMENT_FAILURE_CATEGORY, TELEMETRY_ATTRIBUTES } from "@cup/telemetry.core";

export type StoppedWorkflow =
  | { kind: "preparation"; conversionId: string }
  | { kind: "audio-segment"; conversionId: string; sequence: number };

class StoppedWorkflowError extends CupError {
  override name = "StoppedWorkflowError";
}

export function captureStoppedWorkflow(workflow: StoppedWorkflow): string {
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
        workflow.kind === "preparation"
          ? ("workflow-platform" satisfies ConversionFailureCategory)
          : SEGMENT_FAILURE_CATEGORY,
    },
  });
}
