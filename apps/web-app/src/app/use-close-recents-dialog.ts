import { useRouter } from "@tanstack/react-router";
import React from "react";

import { useReturnToRecents } from "#src/app/return-to-recents.js";
import type { FileRouteTypes } from "#src/routeTree.gen.js";

export function useCloseRecentsDialog(routeId: FileRouteTypes["id"]): () => void {
  const router = useRouter();
  const returnToRecents = useReturnToRecents();
  const isClosing = React.useRef(false);

  return () => {
    const isDialogShown = router.state.matches.some((match) => match.routeId === routeId);
    if (isClosing.current || !isDialogShown) {
      return;
    }
    isClosing.current = true;

    void returnToRecents();
  };
}
