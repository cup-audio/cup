import { css } from "@linaria/core";
import { useSuspenseQuery } from "@tanstack/react-query";
import React from "react";

import { crashReportsQuery, useSetCrashReportsMutation } from "#src/data-fetching/crash-reports.js";

export function CrashReportsSetting(): React.ReactNode {
  return (
    <React.Suspense fallback={null}>
      <CrashReportsSwitch />
    </React.Suspense>
  );
}

function CrashReportsSwitch(): React.ReactNode {
  const crashReports = useSuspenseQuery(crashReportsQuery());
  const setCrashReports = useSetCrashReportsMutation();
  const isEnabled = setCrashReports.isPending ? setCrashReports.variables : crashReports.data;

  return (
    <section aria-label="Crash reports">
      <h3>Crash reports</h3>
      <label
        className={css`
          display: flex;
          gap: var(--spacing-base);
          align-items: center;
        `}
      >
        <input
          type="checkbox"
          role="switch"
          checked={isEnabled}
          aria-checked={isEnabled}
          disabled={setCrashReports.isPending}
          onChange={(event) => setCrashReports.mutate(event.target.checked)}
        />
        Send crash reports
      </label>
      <p>
        When the app crashes, it sends a report so the crash can be fixed. Turning this off deletes
        the crash data stored on this device; the app stops sending crash reports the next time it
        starts.
      </p>
    </section>
  );
}
