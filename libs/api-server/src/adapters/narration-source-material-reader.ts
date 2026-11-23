import {
  loadNarrationSourceMaterial,
  type NarrationSourceMaterialReference,
} from "@cup/audiobook-production";

import type { ApiServerEnvironment } from "#src/api-server-environment.ts";

export function createNarrationSourceMaterialReader(
  env: Pick<ApiServerEnvironment, "AUDIO_BUCKET">,
): (reference: NarrationSourceMaterialReference) => Promise<string> {
  return (reference) => loadNarrationSourceMaterial({ bucket: env.AUDIO_BUCKET, reference });
}
