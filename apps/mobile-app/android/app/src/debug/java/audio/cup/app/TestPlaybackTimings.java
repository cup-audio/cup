package audio.cup.app;

import android.content.Intent;
import androidx.annotation.Nullable;

final class TestPlaybackTimings {
    static final String SIGNED_URL_LIFETIME_EXTRA = "cupTestSignedUrlLifetimeSeconds";
    static final String FOREGROUND_GRACE_EXTRA = "cupTestForegroundGraceSeconds";

    private static final long RELEASE_SIGNED_URL_LIFETIME_MILLISECONDS = PlaybackTimings.signedUrlLifetimeMilliseconds;
    private static final long RELEASE_FOREGROUND_GRACE_MILLISECONDS = PlaybackTimings.foregroundGraceMilliseconds;

    private TestPlaybackTimings() {}

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
