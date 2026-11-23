package audio.cup.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CupTestRendererCrash")
public class TestRendererCrashPlugin extends Plugin {
    @PluginMethod
    public void crash(PluginCall call) {
        call.resolve();
        getActivity().runOnUiThread(() -> getBridge().getWebView().loadUrl("chrome://crash"));
    }
}
