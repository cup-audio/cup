import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import { CrashReportsSetting } from "#src/app/components/crash-reports-setting.js";
import { queryClient } from "#src/data-fetching/query-client.js";
import type { Story } from "#src/ui-gallery/story.js";

/** The switch alone; a test fakes the shell's `CrashReporting` plugin before mounting it. */
export const Default: Story = {
  component: () => (
    <QueryClientProvider client={queryClient}>
      <CrashReportsSetting />
    </QueryClientProvider>
  ),
};
