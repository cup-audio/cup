package audio.cup.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Debug builds only. Takes audio focus from Cup's player on an adb command, the way a call, a
 * navigation prompt or another media app would, so the mobile E2E suite can check how ExoPlayer
 * reacts without real apps:
 *
 * <pre>
 * adb shell am broadcast -p audio.cup.app -a audio.cup.app.FOCUS_PROBE --es focus transient
 * </pre>
 *
 * <p>{@code focus} is {@code transient} (as a call), {@code duck} (as a navigation prompt),
 * {@code full} (as another media app) or {@code abandon}, which gives the focus back. The receiver
 * is registered only while the app runs with the test API origin.
 */
@RequiresApi(Build.VERSION_CODES.O)
@CapacitorPlugin(name = "CupFocusProbe")
public class FocusProbePlugin extends Plugin {
    private static final String ACTION = "audio.cup.app.FOCUS_PROBE";
    private static final String TAG = "CupFocusProbe";

    @Nullable
    private AudioFocusRequest request;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String focus = intent.getStringExtra("focus");
            if ("abandon".equals(focus)) {
                abandon();
                return;
            }
            Integer gain = toFocusGain(focus);
            if (gain == null) {
                Log.e(TAG, "Unknown focus request: " + focus);
                return;
            }
            requestFocus(gain);
        }
    };

    @Override
    public void load() {
        // adb broadcasts come from the shell, so the receiver must be exported.
        ContextCompat.registerReceiver(getContext(), receiver, new IntentFilter(ACTION), ContextCompat.RECEIVER_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        abandon();
        getContext().unregisterReceiver(receiver);
    }

    private void requestFocus(int gain) {
        abandon();
        AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(
                gain == AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
                    ? AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE
                    : gain == AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
                        ? AudioAttributes.USAGE_VOICE_COMMUNICATION
                        : AudioAttributes.USAGE_MEDIA
            )
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();
        request = new AudioFocusRequest.Builder(gain)
            .setAudioAttributes(attributes)
            .setOnAudioFocusChangeListener(change -> Log.i(TAG, "Focus probe focus change " + change))
            .build();
        int result = audioManager().requestAudioFocus(request);
        Log.i(TAG, "Focus probe requested gain " + gain + ", result " + result);
    }

    private void abandon() {
        if (request == null) {
            return;
        }
        audioManager().abandonAudioFocusRequest(request);
        request = null;
        Log.i(TAG, "Focus probe abandoned its focus");
    }

    private AudioManager audioManager() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    @Nullable
    private static Integer toFocusGain(@Nullable String focus) {
        if ("transient".equals(focus)) {
            return AudioManager.AUDIOFOCUS_GAIN_TRANSIENT;
        }
        if ("duck".equals(focus)) {
            return AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK;
        }
        if ("full".equals(focus)) {
            return AudioManager.AUDIOFOCUS_GAIN;
        }
        return null;
    }
}
