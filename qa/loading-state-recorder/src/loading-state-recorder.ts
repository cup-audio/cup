import type { Page } from "@playwright/test";
import { z } from "zod";

const LOADING_STATE_MARKERS = ["data-loading-state", "data-pending-signal"] as const;

const loadingStateRecordSchema = z.array(
  z.object({
    marker: z.enum(LOADING_STATE_MARKERS),
    name: z.string(),
    at: z.number(),
  }),
);

export type LoadingStateRecord = z.infer<typeof loadingStateRecordSchema>[number];

const RECORD_KEY = "cupLoadingStateRecord";

export async function recordLoadingStates(page: Page): Promise<void> {
  await page.addInitScript(
    ({ recordKey, markers }) => {
      const record: LoadingStateRecord[] = [];
      Object.assign(window, { [recordKey]: record });

      const selector = markers.map((marker) => `[${marker}]`).join(", ");
      new MutationObserver((mutations) => {
        const insertedElements = new Set<Element>();
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (!(node instanceof Element)) {
              continue;
            }
            if (node.matches(selector)) {
              insertedElements.add(node);
            }
            for (const descendant of node.querySelectorAll(selector)) {
              insertedElements.add(descendant);
            }
          }
        }

        const now = performance.now();
        for (const element of insertedElements) {
          const marker = markers.find((candidate) => element.hasAttribute(candidate));
          if (marker === undefined) {
            throw new Error("An element matched the marker selector without carrying a marker.");
          }
          record.push({
            marker,
            name: element.getAttribute("aria-label") ?? element.textContent.trim(),
            at: now,
          });
        }
      }).observe(document, { childList: true, subtree: true });
    },
    { recordKey: RECORD_KEY, markers: LOADING_STATE_MARKERS },
  );
}

export async function readLoadingStateRecord(page: Page): Promise<LoadingStateRecord[]> {
  const record = await page.evaluate(
    (recordKey): unknown => Reflect.get(window, recordKey),
    RECORD_KEY,
  );
  if (record === undefined) {
    throw new Error("No loading state record: call recordLoadingStates before the page loads.");
  }
  return loadingStateRecordSchema.parse(record);
}
