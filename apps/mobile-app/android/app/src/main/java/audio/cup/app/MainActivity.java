package audio.cup.app;

import android.content.Intent;
import android.os.Bundle;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import com.getcapacitor.BridgeActivity;
import io.sentry.android.core.InMemoryInstallation;

public class MainActivity extends BridgeActivity {
    @OptIn(markerClass = UnstableApi.class)
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        InMemoryInstallation.use();
        CrashReportingPlugin.deleteSentryFilesIfDisabled(this);
        registerPlugin(AndroidSharePlugin.class);
        registerPlugin(CrashReportingPlugin.class);
        registerPlugin(WebViewProcessLossPlugin.class);
        registerPlugin(MediaPlaybackPlugin.class);
        registerPlugin(WebAuthenticationPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() != null) {
            getBridge().addWebViewListener(WebViewProcessLoss.recreateOnRendererGone(this));
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        setIntent(intent);
        super.onNewIntent(intent);
    }
}
