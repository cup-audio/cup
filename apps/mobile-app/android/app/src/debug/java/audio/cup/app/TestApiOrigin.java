package audio.cup.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.annotation.Nullable;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class TestApiOrigin {
    static final String EXTRA = "cupTestApiOrigin";
    private static final String PREFERENCES = "audio.cup.app.test_api_origin";
    private static final Pattern LOCALHOST_ORIGIN = Pattern.compile("http://localhost:([1-9][0-9]{0,4})");

    private TestApiOrigin() {}

    @Nullable
    static String of(Context context, @Nullable Intent intent) {
        SharedPreferences preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        String launched = fromIntent(intent);
        if (launched != null) {
            preferences.edit().putString(EXTRA, launched).commit();
            return launched;
        }
        String stored = preferences.getString(EXTRA, null);
        return stored == null ? null : validated(stored);
    }

    @Nullable
    static String fromIntent(@Nullable Intent intent) {
        String value = intent == null ? null : intent.getStringExtra(EXTRA);
        return value == null ? null : validated(value);
    }

    private static String validated(String value) {
        Matcher matcher = LOCALHOST_ORIGIN.matcher(value);
        if (!matcher.matches() || Integer.parseInt(matcher.group(1)) > 65535) {
            throw new IllegalArgumentException(
                "The " + EXTRA + " launch argument must be exactly http://localhost:<port>, got \"" + value + "\"."
            );
        }
        return value;
    }
}
