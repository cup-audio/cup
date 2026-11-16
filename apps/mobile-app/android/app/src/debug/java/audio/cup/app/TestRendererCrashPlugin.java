package audio.cup.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Debug builds only, registered with a test API origin: lets the mobile E2E suite crash the
 * WebView's renderer process, as {@link WebViewProcessLoss} handles it.
 */
@CapacitorPlugin(name = "CupTestRendererCrash")
public class TestRendererCrashPlugin extends Plugin {
    @PluginMethod
    public void crash(PluginCall call) {
        // Answered first: the page that called it dies with its renderer.
        call.resolve();
        getActivity().runOnUiThread(() -> getBridge().getWebView().loadUrl("chrome://crash"));
    }
}
