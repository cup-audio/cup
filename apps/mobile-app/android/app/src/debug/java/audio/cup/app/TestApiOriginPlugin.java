package audio.cup.app;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Collections;
import org.json.JSONObject;

/**
 * Debug builds only. Points the web app at the test Worker: before the page loads, it sets the
 * global that {@code apiOrigin()} reads, and with a {@link TestSentryDsn} the global the web app's
 * telemetry reads, and it lets the {@code https://localhost} page load {@code http://localhost}
 * media. Capacitor loads plugins after creating the WebView and before loading the page.
 */
@CapacitorPlugin(name = "CupTestApiOrigin")
public class TestApiOriginPlugin extends Plugin {
    @Override
    public void load() {
        try {
            String origin = TestApiOrigin.fromIntent(getActivity().getIntent());
            if (origin == null) {
                return;
            }
            String sentryDsn = TestSentryDsn.fromIntent(getActivity().getIntent());
            WebView webView = getBridge().getWebView();
            String pageOrigin = Uri.parse(getBridge().getLocalUrl()).buildUpon().path(null).build().toString();
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                String script = "window.cupTestApiOrigin = " + JSONObject.quote(origin) + ";";
                if (sentryDsn != null) {
                    // The web app's telemetry, and through it the native Sentry SDK, sends only here.
                    script += " window.cupTestSentryDsn = " + JSONObject.quote(sentryDsn) + ";";
                }
                WebViewCompat.addDocumentStartJavaScript(webView, script, Collections.singleton(pageOrigin));
            } else {
                throw new IllegalStateException("This WebView cannot run document-start scripts.");
            }
            webView.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        } catch (RuntimeException error) {
            // Capacitor logs and ignores plugin load errors; crash instead of talking to production.
            new Handler(Looper.getMainLooper()).post(() -> {
                throw new IllegalStateException("The test API origin could not be applied.", error);
            });
        }
    }
}
