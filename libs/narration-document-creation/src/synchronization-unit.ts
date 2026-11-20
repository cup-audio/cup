import { z } from "zod";

/** Runtime schema for one independently addressable narration unit. */
export const SYNCHRONIZATION_UNIT_SCHEMA = z
  .object({
    id: z.string().min(1),
    narrationText: z.string().min(1),
    // Written only by speech policy 7's narration document creation (2026-11-13, ADR 0028), and
    // kept so the manifests it prepared still load; nothing reads it.
    continuesNarrationBlock: z.literal(true).optional(),
  })
  .strict();

/** One independently addressable piece of displayed and spoken narration. */
export type SynchronizationUnit = z.infer<typeof SYNCHRONIZATION_UNIT_SCHEMA>;
