import type { Page } from "@playwright/test";
import { z } from "zod";

const COVER_TRANSITION_NAME = "track-cover";

const BOTTOM_BAR_NAME = "bottom-bar";

const SCREEN_NAMES = ["detail-header", "detail-screen", "recents-screen"];

const coverPlaceSchema = z.enum(["card", "detail"]);

const viewTransitionRecordSchema = z.array(
  z.object({
    types: z.array(z.string()).optional(),
    oldCovers: z.array(coverPlaceSchema),
    newCovers: z.array(coverPlaceSchema),
    bottomBarGap: z.number().optional(),
    isNamedBottomBarSticky: z.boolean(),
    isBottomBarAboveCover: z.boolean(),
    isBottomBarPair: z.boolean(),
    fadingScreens: z.array(z.string()),
    isDocumentCaptured: z.boolean(),
  }),
);

export type ViewTransitionRecord = z.infer<typeof viewTransitionRecordSchema>[number];

const RECORD_KEY = "cupViewTransitionRecord";

export async function recordViewTransitions(page: Page): Promise<void> {
  await page.addInitScript(
    ({ recordKey, coverTransitionName, bottomBarName, screenNames }) => {
      const record: unknown[] = [];
      Object.assign(window, { [recordKey]: record });

      const findCovers = () =>
        [...document.querySelectorAll("[data-track-cover]")]
          .filter((element) => getComputedStyle(element).viewTransitionName === coverTransitionName)
          .map((element) => (element.closest("li") ? "card" : "detail"));

      const isBottomBarAboveCover = () =>
        getComputedStyle(document.documentElement, `::view-transition-group(${bottomBarName})`)
          .zIndex === "2";

      const isNamedBottomBarSticky = () =>
        [...document.querySelectorAll("*")].some((element) => {
          const style = getComputedStyle(element);
          return style.viewTransitionName === bottomBarName && style.position === "sticky";
        });

      const hasBottomBarPair = (pseudoElements: (string | null)[]) =>
        pseudoElements.includes(`::view-transition-old(${bottomBarName})`) &&
        pseudoElements.includes(`::view-transition-new(${bottomBarName})`);

      const startViewTransition = document.startViewTransition.bind(document);
      document.startViewTransition = (options) => {
        const transition = startViewTransition(options);
        const oldCovers = findCovers();
        void (async () => {
          try {
            await transition.ready;
          } catch {
            return;
          }
          const bottomBar =
            document.querySelector('footer[aria-label="Player"]') ??
            document.querySelector('section[aria-label="Player"]')?.parentElement;
          const pseudoElements = document
            .getAnimations()
            .map(({ effect }) => (effect instanceof KeyframeEffect ? effect.pseudoElement : null));
          record.push({
            ...(typeof options === "object" && { types: options.types }),
            oldCovers,
            newCovers: findCovers(),
            isBottomBarAboveCover: isBottomBarAboveCover(),
            isBottomBarPair: hasBottomBarPair(pseudoElements),
            fadingScreens: screenNames.filter((name) =>
              pseudoElements.some((element) => element?.endsWith(`(${name})`)),
            ),
            isDocumentCaptured: pseudoElements.some((element) => element?.endsWith("(root)")),
            isNamedBottomBarSticky: isNamedBottomBarSticky(),
            bottomBarGap:
              bottomBar && Math.round(innerHeight - bottomBar.getBoundingClientRect().bottom),
          });
        })();
        return transition;
      };
    },
    {
      recordKey: RECORD_KEY,
      coverTransitionName: COVER_TRANSITION_NAME,
      bottomBarName: BOTTOM_BAR_NAME,
      screenNames: SCREEN_NAMES,
    },
  );
}

export async function readViewTransitionRecord(page: Page): Promise<ViewTransitionRecord[]> {
  const record = await page.evaluate(
    (recordKey): unknown => Reflect.get(window, recordKey),
    RECORD_KEY,
  );
  if (record === undefined) {
    throw new Error("No view transition record: call recordViewTransitions before the page loads.");
  }
  return viewTransitionRecordSchema.parse(record);
}
