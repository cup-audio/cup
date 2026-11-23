import { z } from "zod";

export const SYNCHRONIZATION_UNIT_SCHEMA = z
  .object({
    id: z.string().min(1),
    narrationText: z.string().min(1),
    continuesNarrationBlock: z.literal(true).optional(),
  })
  .strict();

export type SynchronizationUnit = z.infer<typeof SYNCHRONIZATION_UNIT_SCHEMA>;
