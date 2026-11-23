package audio.cup.app;

import android.app.Activity;
import android.app.Application;
import android.content.Intent;
import android.os.Bundle;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class DebugApplication extends Application {
    static final String REAL_GOOGLE_SIGN_IN_EXTRA = "cupTestRealGoogleSignIn";

    @Override
    public void onCreate() {
        super.onCreate();
        registerActivityLifecycleCallbacks(new LaunchArgumentsCallbacks());
    }

    private static final class LaunchArgumentsCallbacks implements ActivityLifecycleCallbacks {
        @Override
        public void onActivityPreCreated(@NonNull Activity activity, @Nullable Bundle savedInstanceState) {
            if (!(activity instanceof BridgeActivity)) {
                return;
            }
            TestSentryDsn.fromIntent(activity.getIntent());
            if (TestApiOrigin.fromIntent(activity.getIntent()) != null) {
                ((BridgeActivity) activity).registerPlugin(TestApiOriginPlugin.class);
                ((BridgeActivity) activity).registerPlugin(TestRendererCrashPlugin.class);
                ((BridgeActivity) activity).registerPlugin(FocusProbePlugin.class);
                TestPlaybackTimings.apply(activity.getIntent());
            }
        }

        @Override
        public void onActivityPostCreated(@NonNull Activity activity, @Nullable Bundle savedInstanceState) {
            if (!(activity instanceof BridgeActivity)) {
                return;
            }
            Intent intent = activity.getIntent();
            if (TestApiOrigin.fromIntent(intent) == null || intent.getBooleanExtra(REAL_GOOGLE_SIGN_IN_EXTRA, false)) {
                return;
            }
            Bridge bridge = ((BridgeActivity) activity).getBridge();
            bridge.registerPlugin(FakeGoogleSignInPlugin.class);
        }

        @Override
        public void onActivityCreated(@NonNull Activity activity, @Nullable Bundle savedInstanceState) {}

        @Override
        public void onActivityStarted(@NonNull Activity activity) {}

        @Override
        public void onActivityResumed(@NonNull Activity activity) {}

        @Override
        public void onActivityPaused(@NonNull Activity activity) {}

        @Override
        public void onActivityStopped(@NonNull Activity activity) {}

        @Override
        public void onActivitySaveInstanceState(@NonNull Activity activity, @NonNull Bundle outState) {}

        @Override
        public void onActivityDestroyed(@NonNull Activity activity) {}
    }
}
