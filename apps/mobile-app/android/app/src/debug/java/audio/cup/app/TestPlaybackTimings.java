package audio.cup.app;

import android.content.Intent;
import androidx.annotation.Nullable;

/**
 * Debug builds only: the mobile E2E suite's shortened media session timings, passed as intent
 * extras with the test origin. A launch without them restores the release values.
 */
final class TestPlaybackTimings {
    /** How long the plugin treats the URLs as valid, matching the test Worker's signed URL lifetime. */
    static final String SIGNED_URL_LIFETIME_EXTRA = "cupTestSignedUrlLifetimeSeconds";
    /** Media3's foreground grace after a pause, about 10 s instead of 10 minutes. */
    static final String FOREGROUND_GRACE_EXTRA = "cupTestForegroundGraceSeconds";

    private static final long RELEASE_SIGNED_URL_LIFETIME_MILLISECONDS = PlaybackTimings.signedUrlLifetimeMilliseconds;
    private static final long RELEASE_FOREGROUND_GRACE_MILLISECONDS = PlaybackTimings.foregroundGraceMilliseconds;

    private TestPlaybackTimings() {}

    /** Takes effect for the next load and the next start of the service. */
    static void apply(@Nullable Intent launch) {
        PlaybackTimings.signedUrlLifetimeMilliseconds = readMilliseconds(
            launch,
            SIGNED_URL_LIFETIME_EXTRA,
            RELEASE_SIGNED_URL_LIFETIME_MILLISECONDS
        );
        PlaybackTimings.foregroundGraceMilliseconds = readMilliseconds(
            launch,
            FOREGROUND_GRACE_EXTRA,
            RELEASE_FOREGROUND_GRACE_MILLISECONDS
        );
    }

    /** @throws IllegalArgumentException for a value that is not a positive number of seconds */
    private static long readMilliseconds(@Nullable Intent launch, String extra, long fallback) {
        if (launch == null || !launch.hasExtra(extra)) {
            return fallback;
        }
        int seconds = launch.getIntExtra(extra, 0);
        if (seconds <= 0) {
            throw new IllegalArgumentException("The " + extra + " launch argument must be a positive number of seconds.");
        }
        return seconds * 1_000L;
    }
}
