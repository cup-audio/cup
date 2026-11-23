import type { ConversionPhase } from "@cup/conversion-contracts";

export function phaseStepName(phase: ConversionPhase, action: string): string {
  return `${phase}: ${action}`;
}
