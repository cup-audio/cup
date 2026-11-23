import type { AnyRouter, ParsedLocation } from "@tanstack/react-router";
import React from "react";

import {
  TRACK_COVER_ATTRIBUTE,
  TRACK_COVER_TRANSITION_NAME,
} from "#src/app/view-transition-names.js";
import type { FileRoutesById } from "#src/routeTree.gen.js";

const COVER_TRANSITION_TYPE = "track-cover";
const SCREEN_FADE_TYPE = "screen-fade";

const RECENTS_ROUTE_ID = "/_shell/recent" satisfies keyof FileRoutesById;
const DETAIL_ROUTE_ID = "/_shell/audiobooks/$conversionId" satisfies keyof FileRoutesById;

let coverNameRule: CSSStyleSheet | undefined;
let isPopStateVisualTransition = false;

let viewTransitionLocation: ParsedLocation | undefined;
const viewTransitionLocationListeners = new Set<() => void>();

export function createCoverViewTransition(router: Pick<AnyRouter, "getMatchedRoutes">):
  | false
  | {
      types: (change: {
        fromLocation?: ParsedLocation;
        toLocation: ParsedLocation;
      }) => string[] | false;
    } {
  if (!supportsViewTransitionTypes()) {
    return false;
  }

  if (coverNameRule === undefined) {
    coverNameRule = new CSSStyleSheet();
    document.adoptedStyleSheets.push(coverNameRule);

    window.addEventListener(
      "popstate",
      (event) => {
        isPopStateVisualTransition = event.hasUAVisualTransition;
      },
      { capture: true },
    );
  }
  const rule = coverNameRule;

  return {
    types: ({ fromLocation, toLocation }) => {
      const hasVisualTransition = isPopStateVisualTransition;
      isPopStateVisualTransition = false;

      const conversionId = findCoverTransitionConversionId(
        router,
        fromLocation?.pathname,
        toLocation.pathname,
      );
      if (conversionId === undefined || hasVisualTransition || prefersReducedMotion()) {
        return false;
      }

      const isOpenedFromMiniPlayer =
        fromLocation?.state.isOpenedFromMiniPlayer === true ||
        toLocation.state.isOpenedFromMiniPlayer === true;
      const coverSelector = `[${TRACK_COVER_ATTRIBUTE}="${CSS.escape(conversionId)}"]`;
      if (isOpenedFromMiniPlayer || !isInViewport(document.querySelector(coverSelector))) {
        recordViewTransitionStart(toLocation);
        return [SCREEN_FADE_TYPE];
      }

      rule.replaceSync(
        `:root:active-view-transition-type(${COVER_TRANSITION_TYPE}) ${coverSelector} {
          view-transition-name: ${TRACK_COVER_TRANSITION_NAME};
        }`,
      );
      recordViewTransitionStart(toLocation);
      return [COVER_TRANSITION_TYPE];
    },
  };
}

export function useHasViewTransitionStarted(location: ParsedLocation): boolean {
  const startedLocation = React.useSyncExternalStore(
    subscribeToViewTransitionLocation,
    () => viewTransitionLocation,
  );
  return startedLocation === location;
}

function recordViewTransitionStart(location: ParsedLocation): void {
  viewTransitionLocation = location;
  for (const listener of viewTransitionLocationListeners) {
    listener();
  }
}

function subscribeToViewTransitionLocation(listener: () => void): () => void {
  viewTransitionLocationListeners.add(listener);
  return () => viewTransitionLocationListeners.delete(listener);
}

export function coverTransitionTarget(conversionId: string): {
  [TRACK_COVER_ATTRIBUTE]: string;
} {
  return { [TRACK_COVER_ATTRIBUTE]: conversionId };
}

function supportsViewTransitionTypes(): boolean {
  return (
    typeof window !== "undefined" &&
    window.CSS.supports("selector(:active-view-transition-type(a))")
  );
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isInViewport(element: Element | null): boolean {
  if (element === null) {
    return false;
  }

  const { top, right, bottom, left } = element.getBoundingClientRect();
  return bottom > 0 && top < window.innerHeight && right > 0 && left < window.innerWidth;
}

function findCoverTransitionConversionId(
  router: Pick<AnyRouter, "getMatchedRoutes">,
  fromPathname: string | undefined,
  toPathname: string,
): string | undefined {
  if (fromPathname === undefined) {
    return undefined;
  }

  const findRouteId = (pathname: string) => router.getMatchedRoutes(pathname)[2]?.id;
  const detailPathname =
    findRouteId(fromPathname) === RECENTS_ROUTE_ID
      ? toPathname
      : findRouteId(toPathname) === RECENTS_ROUTE_ID
        ? fromPathname
        : undefined;
  if (detailPathname === undefined) {
    return undefined;
  }

  const [, params, route] = router.getMatchedRoutes(detailPathname);
  return route?.id === DETAIL_ROUTE_ID ? params["conversionId"] : undefined;
}
