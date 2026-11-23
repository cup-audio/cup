import { queryOptions, useMutation } from "@tanstack/react-query";

import { queryClient } from "#src/data-fetching/query-client.js";
import { QUERY_KEYS } from "#src/data-fetching/query-keys.js";
import {
  readCrashReportsEnabled,
  writeCrashReportsEnabled,
} from "#src/platform/crash-reporting.js";

export const crashReportsQuery = () =>
  queryOptions({
    queryKey: QUERY_KEYS.crashReports(),
    queryFn: readCrashReportsEnabled,
    meta: { errorTitle: "The crash reports setting could not be read." },
  });

export function useSetCrashReportsMutation() {
  return useMutation({
    meta: { errorTitle: "The crash reports setting could not be changed." },
    mutationFn: writeCrashReportsEnabled,
    onSuccess: (_result, enabled) => {
      queryClient.setQueryData(QUERY_KEYS.crashReports(), enabled);
    },
  });
}
