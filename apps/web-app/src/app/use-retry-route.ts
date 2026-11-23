import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";

export function useRetryRoute(): () => void {
  const router = useRouter();
  const queryErrorResetBoundary = useQueryErrorResetBoundary();

  return () => {
    queryErrorResetBoundary.reset();
    void router.invalidate();
  };
}
