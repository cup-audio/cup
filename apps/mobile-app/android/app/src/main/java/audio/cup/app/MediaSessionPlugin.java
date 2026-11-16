package audio.cup.app;

import android.os.Looper;
import androidx.media3.common.util.UnstableApi;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The web app's media session port on Android, whose WebView has no Media Session API
 * ({@code media-session.android.ts}). The page reports the loaded audiobook's metadata, playback and
 * position state, which a {@link MirroringPlayer} mirrors in a Media3 session in the
 * {@link MediaPlaybackService}; every system command comes back as one {@code command} event. The
 * plugin never touches the {@code <audio>}: the page stays the only engine.
 */
@UnstableApi
@CapacitorPlugin(name = "CupMediaSession")
public class MediaSessionPlugin extends Plugin implements MirroringPlayer.CommandListener {
    private MirroringPlayer player;

    @Override
    public void load() {
        player = new MirroringPlayer(Looper.getMainLooper(), this);
    }

    @PluginMethod
    public void setMetadata(PluginCall call) {
        String title = call.getString("title");
        if (title == null) {
            call.reject("The media session metadata needs a title.");
            return;
        }
        String artworkUrl = call.getString("artworkUrl");
        getBridge().executeOnMainThread(() -> player.setMetadata(title, artworkUrl));
        call.resolve();
    }

    @PluginMethod
    public void setPlaybackState(PluginCall call) {
        boolean isPlaying = "playing".equals(call.getString("playbackState"));
        boolean isWaiting = Boolean.TRUE.equals(call.getBoolean("isWaiting", false));
        boolean hasEnded = Boolean.TRUE.equals(call.getBoolean("hasEnded", false));
        getBridge()
            .executeOnMainThread(() -> {
                player.setPlaybackState(isPlaying, isWaiting, hasEnded);
                // Opening an audiobook, or loading it to seek or skip, shows no notification.
                if (isPlaying && player.isLoaded()) {
                    MediaPlaybackService.start(getContext(), player);
                }
            });
        call.resolve();
    }

    @PluginMethod
    public void setPositionState(PluginCall call) {
        Double duration = call.getDouble("durationMilliseconds");
        Double position = call.getDouble("positionMilliseconds");
        Float playbackRate = call.getFloat("playbackRate", 1f);
        if (duration == null || position == null || playbackRate == null) {
            call.reject("The media session position state needs a duration, a position and a rate.");
            return;
        }
        getBridge()
            .executeOnMainThread(() -> player.setPositionState(Math.round(duration), Math.round(position), playbackRate));
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        getBridge().executeOnMainThread(() -> player.clear());
        call.resolve();
    }

    @Override
    public void onPlay() {
        MediaPlaybackService.whenInForeground(() -> sendCommand("play"));
    }

    @Override
    public void onPause() {
        sendCommand("pause");
    }

    @Override
    public void onStop() {
        sendCommand("stop");
    }

    @Override
    public void onSeekTo(long positionMilliseconds) {
        JSObject command = new JSObject();
        command.put("action", "seekto");
        command.put("positionMilliseconds", positionMilliseconds);
        notifyListeners("command", command);
    }

    @Override
    public void onSeekBackward(long offsetMilliseconds) {
        sendSkip("seekbackward", offsetMilliseconds);
    }

    @Override
    public void onSeekForward(long offsetMilliseconds) {
        sendSkip("seekforward", offsetMilliseconds);
    }

    private void sendCommand(String action) {
        JSObject command = new JSObject();
        command.put("action", action);
        notifyListeners("command", command);
    }

    private void sendSkip(String action, long offsetMilliseconds) {
        JSObject command = new JSObject();
        command.put("action", action);
        command.put("offsetMilliseconds", offsetMilliseconds);
        notifyListeners("command", command);
    }
}
