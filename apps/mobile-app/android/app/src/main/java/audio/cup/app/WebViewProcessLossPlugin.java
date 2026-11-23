package audio.cup.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "WebViewProcessLoss")
public class WebViewProcessLossPlugin extends Plugin {
    @PluginMethod
    public void takeLoss(PluginCall call) {
        JSObject result = new JSObject();
        JSObject loss = WebViewProcessLoss.take(getContext());
        if (loss != null) {
            result.put("loss", loss);
        }
        call.resolve(result);
    }
}
