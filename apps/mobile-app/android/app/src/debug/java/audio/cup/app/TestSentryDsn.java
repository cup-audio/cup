package audio.cup.app;

import android.content.Intent;
import androidx.annotation.Nullable;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Debug builds only: the Sentry stub's DSN the mobile E2E suite passes as an intent extra next to
 * {@link TestApiOrigin}. Without it, a debug build sends nothing to Sentry.
 */
final class TestSentryDsn {
    static final String EXTRA = "cupTestSentryDsn";
    /** The stub listens on the host's 127.0.0.1, which {@code adb reverse} maps onto the device's. */
    private static final Pattern STUB_DSN = Pattern.compile("http://[0-9A-Za-z]+@127\\.0\\.0\\.1:([1-9][0-9]{0,4})/[0-9]+");

    private TestSentryDsn() {}

    /**
     * Returns the DSN, or null when the launch carries none.
     *
     * @throws IllegalArgumentException when the value is anything but
     *     {@code http://<key>@127.0.0.1:<port>/<project>}, or when the launch carries no test API
     *     origin, whose telemetry tunnel the web app sends through
     */
    @Nullable
    static String fromIntent(@Nullable Intent intent) {
        String value = intent == null ? null : intent.getStringExtra(EXTRA);
        if (value == null) {
            return null;
        }
        Matcher matcher = STUB_DSN.matcher(value);
        if (!matcher.matches() || Integer.parseInt(matcher.group(1)) > 65535) {
            throw new IllegalArgumentException(
                "The " + EXTRA + " launch argument must be exactly http://<key>@127.0.0.1:<port>/<project>, got \"" + value + "\"."
            );
        }
        if (TestApiOrigin.fromIntent(intent) == null) {
            throw new IllegalArgumentException("The " + EXTRA + " launch argument needs " + TestApiOrigin.EXTRA + " too.");
        }
        return value;
    }
}
