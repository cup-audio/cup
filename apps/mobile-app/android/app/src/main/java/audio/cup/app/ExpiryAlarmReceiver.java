package audio.cup.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.media3.common.util.UnstableApi;

@UnstableApi
public class ExpiryAlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        PlaybackEngine.get(context).onExpiryAlarm();
    }
}
