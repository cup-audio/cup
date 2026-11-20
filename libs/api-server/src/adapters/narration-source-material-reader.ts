import {
  loadNarrationSourceMaterial,
  type NarrationSourceMaterialReference,
} from "@cup/audiobook-production";

import type { ApiServerEnvironment } from "#src/api-server-environment.ts";

/**
 * Reads a new conversion's narration source material from the audio bucket, only through the
 * reference its manifest records.
 */
export function createNarrationSourceMaterialReader(
  env: Pick<ApiServerEnvironment, "AUDIO_BUCKET">,
): (reference: NarrationSourceMaterialReference) => Promise<string> {
  return (reference) => loadNarrationSourceMaterial({ bucket: env.AUDIO_BUCKET, reference });
}
