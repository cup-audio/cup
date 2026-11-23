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

@CapacitorPlugin(name = "CrashReporting")
public class CrashReportingPlugin extends Plugin {
    private static final String TAG = "CupCrashReporting";
    private static final String PREFERENCES = "audio.cup.app.crash_reporting";
    private static final String ENABLED_KEY = "enabled";

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
