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

@CapacitorPlugin(name = "CupTestApiOrigin")
public class TestApiOriginPlugin extends Plugin {
    @Override
    public void load() {
        try {
            String origin = TestApiOrigin.of(getActivity(), getActivity().getIntent());
            if (origin == null) {
                return;
            }
            String sentryDsn = TestSentryDsn.fromIntent(getActivity().getIntent());
            WebView webView = getBridge().getWebView();
            String pageOrigin = Uri.parse(getBridge().getLocalUrl()).buildUpon().path(null).build().toString();
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                String script = "window.cupTestApiOrigin = " + JSONObject.quote(origin) + ";";
                if (sentryDsn != null) {
                    script += " window.cupTestSentryDsn = " + JSONObject.quote(sentryDsn) + ";";
                }
                WebViewCompat.addDocumentStartJavaScript(webView, script, Collections.singleton(pageOrigin));
            } else {
                throw new IllegalStateException("This WebView cannot run document-start scripts.");
            }
            webView.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        } catch (RuntimeException error) {
            new Handler(Looper.getMainLooper()).post(() -> {
                throw new IllegalStateException("The test API origin could not be applied.", error);
            });
        }
    }
}
