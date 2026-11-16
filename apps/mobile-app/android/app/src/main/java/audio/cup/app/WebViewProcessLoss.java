package audio.cup.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import androidx.appcompat.app.AppCompatActivity;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSObject;
import com.getcapacitor.WebViewListener;

/**
 * The WebView's renderer process died: Cup records it, recreates its activity so the web app
 * reloads at its start URL, and the restarted web app reports it through {@link
 * WebViewProcessLossPlugin}. Without this, Android ends Cup's whole process with the renderer.
 */
final class WebViewProcessLoss {
    private static final String PREFERENCES = "cup_webview_process_loss";
    private static final String DID_CRASH = "didCrash";
    private static final String RENDERER_PRIORITY_AT_EXIT = "rendererPriorityAtExit";
    private static final String IN_FOREGROUND = "inForeground";

    private WebViewProcessLoss() {}

    /** Recreates {@code activity} whenever its WebView's renderer process is gone. */
    static WebViewListener recreateOnRendererGone(AppCompatActivity activity) {
        return new WebViewListener() {
            @Override
            @RequiresApi(Build.VERSION_CODES.O)
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                boolean inForeground = activity.getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED);
                record(activity, detail, inForeground);
                // Android's guidance: a WebView whose renderer is gone must leave the view hierarchy
                // and never be used again; Capacitor's bridge would otherwise keep calling into it.
                if (webView.getParent() instanceof ViewGroup) {
                    ((ViewGroup) webView.getParent()).removeView(webView);
                }
                webView.destroy();
                activity.recreate();
                // Handled, so Android keeps Cup's process alive.
                return true;
            }
        };
    }

    /** Returns the loss recorded since the last call, as the web app's plugin reads it, and forgets it. */
    @Nullable
    static JSObject take(Context context) {
        SharedPreferences preferences = preferences(context);
        if (!preferences.contains(DID_CRASH)) {
            return null;
        }
        JSObject loss = new JSObject();
        loss.put("platform", "android");
        loss.put(DID_CRASH, preferences.getBoolean(DID_CRASH, false));
        loss.put(RENDERER_PRIORITY_AT_EXIT, preferences.getString(RENDERER_PRIORITY_AT_EXIT, "unknown"));
        loss.put(IN_FOREGROUND, preferences.getBoolean(IN_FOREGROUND, false));
        preferences.edit().clear().apply();
        return loss;
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private static void record(Context context, RenderProcessGoneDetail detail, boolean inForeground) {
        // Synchronously: the recreated activity's web app reads it, and so might a later process.
        preferences(context)
            .edit()
            .putBoolean(DID_CRASH, detail.didCrash())
            .putString(RENDERER_PRIORITY_AT_EXIT, priorityName(detail.rendererPriorityAtExit()))
            .putBoolean(IN_FOREGROUND, inForeground)
            .commit();
    }

    private static String priorityName(int priority) {
        switch (priority) {
            case WebView.RENDERER_PRIORITY_WAIVED:
                return "waived";
            case WebView.RENDERER_PRIORITY_BOUND:
                return "bound";
            case WebView.RENDERER_PRIORITY_IMPORTANT:
                return "important";
            default:
                return "unknown-" + priority;
        }
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
