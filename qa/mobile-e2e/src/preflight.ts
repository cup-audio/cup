import { checkAndroidHost } from "#src/android/preflight.ts";
import { checkIosHost } from "#src/ios/preflight.ts";

const results = await Promise.allSettled([checkAndroidHost(), checkIosHost()]);
for (const result of results) {
  if (result.status === "rejected") {
    console.error(result.reason instanceof Error ? result.reason.message : result.reason);
    process.exitCode = 1;
  }
}
