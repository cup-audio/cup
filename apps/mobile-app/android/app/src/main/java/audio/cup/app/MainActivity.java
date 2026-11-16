package audio.cup.app;

import android.content.Intent;
import android.os.Bundle;
import androidx.annotation.OptIn;
import androidx.media3.common.util.UnstableApi;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @OptIn(markerClass = UnstableApi.class)
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(AndroidSharePlugin.class);
        registerPlugin(MediaSessionPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        setIntent(intent);
        super.onNewIntent(intent);
    }
}
