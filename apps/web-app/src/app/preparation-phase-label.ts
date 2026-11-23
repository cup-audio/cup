import type { PreparationPhase } from "@cup/listener-api.routes";

const LABEL_BY_PREPARATION_PHASE = {
  starting: "Starting",
  "reading-page": "Reading the page",
  "selecting-content": "Selecting narration content",
  "preparing-text": "Preparing the text",
} as const satisfies Record<PreparationPhase, string>;

export function toPreparationPhaseLabel(preparationPhase: PreparationPhase | undefined): string {
  return preparationPhase === undefined
    ? "Preparing"
    : LABEL_BY_PREPARATION_PHASE[preparationPhase];
}
