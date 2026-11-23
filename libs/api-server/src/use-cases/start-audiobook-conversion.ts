import type { TrialWorkflowParams } from "@cup/conversion-contracts";
import type { GrantRegistrySnapshot, StartGrantConversionResult } from "@cup/conversion-grants";

export type StartAudiobookConversionInput = {
  sourceUrl: string;
  grantId: string;
  idempotencyKey: string;
};

export type StartAudiobookConversionDependencies = {
  grant: {
    startConversion(
      sourceUrl: string,
      idempotencyKey: string,
      nowMs?: number,
    ): Promise<StartGrantConversionResult>;
    markWorkflowStarted(conversionId: string): Promise<void>;
  };
  registry: {
    bindConversion(conversionId: string, grantId: string): Promise<void>;
    applyGrantRegistrySnapshot(
      grantSnapshot: GrantRegistrySnapshot,
    ): Promise<"applied" | "replayed" | "stale">;
  };
  createWorkflow(conversionId: string, input: TrialWorkflowParams): Promise<void>;
};

export async function startAudiobookConversion(
  input: StartAudiobookConversionInput,
  dependencies: StartAudiobookConversionDependencies,
): Promise<StartGrantConversionResult> {
  const result = await dependencies.grant.startConversion(input.sourceUrl, input.idempotencyKey);

  if (result.result !== "created") {
    return result;
  }

  await dependencies.registry.bindConversion(result.conversion.conversionId, input.grantId);
  await dependencies.registry.applyGrantRegistrySnapshot(result.registrySnapshot);

  try {
    await dependencies.createWorkflow(result.conversion.conversionId, {
      sourceUrl: input.sourceUrl,
      grantId: input.grantId,
    });
    await dependencies.grant.markWorkflowStarted(result.conversion.conversionId);
  } catch {}

  return result;
}
