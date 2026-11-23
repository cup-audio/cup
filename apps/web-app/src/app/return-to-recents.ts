import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";

export function useIsOpenedFromRecents(): boolean {
  return useLocation({
    select: (location) => location.state.isOpenedFromRecents === true,
  });
}

export function useReturnToRecents(): () => Promise<void> {
  const router = useRouter();
  const navigate = useNavigate();
  const isOpenedFromRecents = useIsOpenedFromRecents();

  return async () => {
    if (!isOpenedFromRecents) {
      await navigate({ to: "/recent", replace: true });
      return;
    }

    const rendered = new Promise<void>((resolve) => {
      const unsubscribe = router.subscribe("onRendered", () => {
        unsubscribe();
        resolve();
      });
    });
    router.history.back();
    await rendered;
  };
}
