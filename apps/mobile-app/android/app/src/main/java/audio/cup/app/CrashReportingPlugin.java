package audio.cup.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

/**
 * The "Send crash reports" switch, on by default. The web app reads it before it starts Sentry and
 * starts the native SDK only while it is on, so turning it off takes full effect on the next start.
 * Turning it off also deletes the native SDK's files, such as crash reports waiting to be sent.
 */
@CapacitorPlugin(name = "CrashReporting")
public class CrashReportingPlugin extends Plugin {
    private static final String TAG = "CupCrashReporting";
    private static final String PREFERENCES = "audio.cup.app.crash_reporting";
    private static final String ENABLED_KEY = "enabled";

    /**
     * Deletes the files a native SDK left while the switch is off. The SDK of the process in which
     * the listener turned the switch off keeps running, and can write again, until the app stops.
     */
    static void deleteSentryFilesIfDisabled(Context context) {
        if (!isEnabled(context)) {
            deleteSentryFiles(context);
        }
    }

    @PluginMethod
    public void isEnabled(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", isEnabled(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("The enabled option must be a boolean.", "INVALID_ARGUMENT");
            return;
        }
        // Written synchronously, so a crash right after the switch changed cannot lose it.
        boolean isStored = preferences(getContext()).edit().putBoolean(ENABLED_KEY, enabled).commit();
        if (!isStored) {
            call.reject("The crash reports setting could not be stored.", "STORAGE_FAILED");
            return;
        }
        if (!enabled) {
            deleteSentryFiles(getContext());
        }
        call.resolve();
    }

    private static boolean isEnabled(Context context) {
        return preferences(context).getBoolean(ENABLED_KEY, true);
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    /**
     * The native SDK keeps everything in its cache folder `cache/sentry/`: options, the outbox and
     * crash reports waiting to be sent. With the NDK off and the installation ID in memory, it
     * writes nowhere else.
     */
    private static void deleteSentryFiles(Context context) {
        File sentryCache = new File(context.getCacheDir(), "sentry");
        if (!deleteRecursively(sentryCache)) {
            Log.w(TAG, "Some of Sentry's files could not be deleted: " + sentryCache);
        }
    }

    private static boolean deleteRecursively(File file) {
        boolean isDeleted = true;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                isDeleted &= deleteRecursively(child);
            }
        }
        return (file.delete() || !file.exists()) && isDeleted;
    }
}
