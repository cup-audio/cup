import type { ConversionPhase } from "@cup/conversion-contracts";

/**
 * Names a Workflow step after the conversion phase it belongs to, followed by what it does. Sentry
 * names each step's span after the step, so the trace shows where a conversion spends its time.
 *
 * A step's name is also the key under which Cloudflare Workflows stores its result, so renaming a
 * step makes an instance that is running during the deploy run that step again.
 */
export function phaseStepName(phase: ConversionPhase, action: string): string {
  return `${phase}: ${action}`;
}
