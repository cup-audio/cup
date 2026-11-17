package audio.cup.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.media3.common.util.UnstableApi;

/**
 * Receives the {@link PlaybackEngine}'s alarm for when a paused session's URLs expire. Android
 * delivers it on the main thread, also after the device slept or froze Cup, when the engine's
 * delayed check may not have run.
 */
@UnstableApi
public class ExpiryAlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        PlaybackEngine.get(context).onExpiryAlarm();
    }
}
