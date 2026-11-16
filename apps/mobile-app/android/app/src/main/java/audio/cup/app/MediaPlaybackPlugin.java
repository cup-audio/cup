package audio.cup.app;

import android.net.Uri;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The narration track's engine in the Android app: a Media3 ExoPlayer that the page drives through
 * the player port ({@code native-track-player.ts}) and that the system's media controls reach through
 * the {@link MediaPlaybackService}'s session. The page sets the loaded audiobook with {@code load},
 * which prepares nothing, and the first {@code play} starts the service. After every change of the
 * player, the plugin sends one {@code state} event; the page asks for {@code getState} whenever it
 * becomes visible, since events sent while the WebView suspends the hidden page can be lost.
 *
 * <p>ExoPlayer handles audio focus with speech attributes, so a call or a navigation prompt pauses
 * Cup and resumes it afterwards, and another app's media pauses it for good; it also pauses when
 * headphones disconnect.
 */
@UnstableApi
@CapacitorPlugin(name = "CupMediaPlayback")
public class MediaPlaybackPlugin extends Plugin {
    /** How far the notification's back and forward buttons skip, as Cup's player does. */
    private static final long SKIP_MILLISECONDS = 15_000;

    @Nullable
    private ExoPlayer player;

    @Nullable
    private SessionPlayer sessionPlayer;

    @Nullable
    private Loaded loaded;

    /** The last load failed, and ExoPlayer paused; the next Play prepares the item again. */
    private boolean hasPlaybackError;

    /** The audiobook loaded into the player. */
    private static final class Loaded {
        final String conversionId;
        final String subject;
        final long durationMilliseconds;

        Loaded(String conversionId, String subject, long durationMilliseconds) {
            this.conversionId = conversionId;
            this.subject = subject;
            this.durationMilliseconds = durationMilliseconds;
        }
    }

    @PluginMethod
    public void load(PluginCall call) {
        String conversionId = call.getString("conversionId");
        String subject = call.getString("subject");
        String trackUrl = call.getString("trackUrl");
        String title = call.getString("title");
        Long durationMilliseconds = readMilliseconds(call, "durationMilliseconds");
        Long startPositionMilliseconds = readMilliseconds(call, "startPositionMilliseconds");
        if (
            conversionId == null ||
            subject == null ||
            trackUrl == null ||
            title == null ||
            durationMilliseconds == null ||
            startPositionMilliseconds == null
        ) {
            call.reject("Loading an audiobook needs its conversion, subject, track URL, title, duration and start.");
            return;
        }
        String artworkUrl = call.getString("artworkUrl");
        MediaItem item = new MediaItem.Builder()
            .setMediaId(conversionId)
            .setUri(trackUrl)
            .setMediaMetadata(
                new MediaMetadata.Builder()
                    .setTitle(title)
                    .setArtworkUri(artworkUrl == null ? null : Uri.parse(artworkUrl))
                    .setDurationMs(durationMilliseconds)
                    .build()
            )
            .build();
        getBridge()
            .executeOnMainThread(() -> {
                ExoPlayer exoPlayer = ensurePlayer();
                loaded = new Loaded(conversionId, subject, durationMilliseconds);
                hasPlaybackError = false;
                // Loading another audiobook leaves it paused, as on the web. While the player was
                // never prepared, setting the item fetches nothing and shows no notification.
                exoPlayer.pause();
                exoPlayer.setMediaItem(item, startPositionMilliseconds);
                sendState(false);
                call.resolve();
            });
    }

    @PluginMethod
    public void play(PluginCall call) {
        onLoadedPlayer(call, exoPlayer -> {
            hasPlaybackError = false;
            if (exoPlayer.getPlaybackState() == Player.STATE_IDLE) {
                // The first Play, or Play after a failed load, which continues where it stopped.
                exoPlayer.prepare();
            }
            exoPlayer.play();
            MediaPlaybackService.start(getContext(), sessionPlayer);
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        onLoadedPlayer(call, Player::pause);
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        Long position = readMilliseconds(call, "positionMilliseconds");
        if (position == null) {
            call.reject("A seek needs a position.");
            return;
        }
        onLoadedPlayer(call, exoPlayer -> exoPlayer.seekTo(clampToTrack(position)));
    }

    @PluginMethod
    public void skipBy(PluginCall call) {
        Long delta = readMilliseconds(call, "deltaMilliseconds");
        if (delta == null) {
            call.reject("A skip needs an amount.");
            return;
        }
        // From ExoPlayer's own position, which can be ahead of the page's last report.
        onLoadedPlayer(call, exoPlayer -> exoPlayer.seekTo(clampToTrack(exoPlayer.getCurrentPosition() + delta)));
    }

    @PluginMethod
    public void replaceUrls(PluginCall call) {
        String trackUrl = call.getString("trackUrl");
        if (trackUrl == null) {
            call.reject("Replacing the URLs needs a track URL.");
            return;
        }
        onLoadedPlayer(call, exoPlayer -> {
            MediaItem current = exoPlayer.getCurrentMediaItem();
            if (current == null) {
                return;
            }
            exoPlayer.setMediaItem(current.buildUpon().setUri(trackUrl).build(), exoPlayer.getCurrentPosition());
        });
    }

    /**
     * Ends the session: on sign-out or a change of the signed-in user ({@code "save"}), or when the
     * loaded audiobook is deleted ({@code "discard"}). The service stops, which removes the
     * notification and releases the player.
     */
    @PluginMethod
    public void close(PluginCall call) {
        getBridge()
            .executeOnMainThread(() -> {
                releasePlayer();
                call.resolve();
            });
    }

    @PluginMethod
    public void getState(PluginCall call) {
        getBridge()
            .executeOnMainThread(() -> {
                JSObject result = new JSObject();
                result.put("state", player == null || loaded == null ? JSObject.NULL : readState(false));
                call.resolve(result);
            });
    }

    @Override
    protected void handleOnDestroy() {
        // A playing session outlives the activity; only the page closes it.
    }

    private ExoPlayer ensurePlayer() {
        if (player != null) {
            return player;
        }
        ExoPlayer exoPlayer = new ExoPlayer.Builder(getContext())
            .setAudioAttributes(
                new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(),
                // With speech, ExoPlayer pauses for a duck request instead of lowering the volume.
                true
            )
            .setHandleAudioBecomingNoisy(true)
            .setSeekBackIncrementMs(SKIP_MILLISECONDS)
            .setSeekForwardIncrementMs(SKIP_MILLISECONDS)
            .build();
        exoPlayer.addListener(new StateReporter());
        player = exoPlayer;
        sessionPlayer = new SessionPlayer(exoPlayer);
        return exoPlayer;
    }

    private void releasePlayer() {
        ExoPlayer exoPlayer = player;
        SessionPlayer wrapper = sessionPlayer;
        player = null;
        sessionPlayer = null;
        loaded = null;
        hasPlaybackError = false;
        if (exoPlayer == null || wrapper == null) {
            return;
        }
        if (!MediaPlaybackService.stop(wrapper)) {
            wrapper.release();
            exoPlayer.release();
        }
    }

    private interface PlayerCommand {
        void run(ExoPlayer exoPlayer);
    }

    private void onLoadedPlayer(PluginCall call, PlayerCommand command) {
        getBridge()
            .executeOnMainThread(() -> {
                ExoPlayer exoPlayer = player;
                if (exoPlayer == null || loaded == null) {
                    call.reject("No audiobook is loaded.");
                    return;
                }
                command.run(exoPlayer);
                call.resolve();
            });
    }

    /** A whole number of milliseconds; JavaScript numbers arrive as integers or doubles. */
    @Nullable
    private static Long readMilliseconds(PluginCall call, String name) {
        Double value = call.getDouble(name);
        return value == null ? null : Math.round(value);
    }

    /** Short of the track's end, as Cup's player seeks. */
    private long clampToTrack(long positionMilliseconds) {
        long duration = loaded == null ? Long.MAX_VALUE : loaded.durationMilliseconds;
        return Math.max(0, Math.min(positionMilliseconds, duration - 1));
    }

    private void sendState(boolean hasEnded) {
        if (player == null || loaded == null) {
            return;
        }
        notifyListeners("state", readState(hasEnded));
    }

    private JSObject readState(boolean hasEnded) {
        ExoPlayer exoPlayer = player;
        Loaded audiobook = loaded;
        if (exoPlayer == null || audiobook == null) {
            throw new IllegalStateException("The plugin has no loaded audiobook to report.");
        }
        int playbackState = exoPlayer.getPlaybackState();
        // Paused for a transient loss of audio focus, such as a call, ExoPlayer still wants to play.
        boolean isPlaying =
            exoPlayer.getPlayWhenReady() &&
            exoPlayer.getPlaybackSuppressionReason() == Player.PLAYBACK_SUPPRESSION_REASON_NONE &&
            playbackState != Player.STATE_ENDED &&
            !hasPlaybackError;
        long duration = exoPlayer.getDuration();

        JSObject state = new JSObject();
        state.put("conversionId", audiobook.conversionId);
        state.put("subject", audiobook.subject);
        state.put("isPlaying", isPlaying);
        state.put("isBuffering", isPlaying && playbackState != Player.STATE_READY);
        state.put("hasEnded", hasEnded);
        state.put("durationMilliseconds", duration == C.TIME_UNSET ? 0 : duration);
        state.put("positionMilliseconds", exoPlayer.getCurrentPosition());
        state.put("positionReadAt", System.currentTimeMillis());
        state.put("error", hasPlaybackError ? "playback" : JSObject.NULL);
        return state;
    }

    /** Reports every change of the player to the page. */
    private final class StateReporter implements Player.Listener {
        @Override
        public void onEvents(@NonNull Player eventPlayer, @NonNull Player.Events events) {
            if (eventPlayer.getPlaybackState() == Player.STATE_ENDED) {
                // A finished audiobook starts over the next time, as in Cup's player. The seek and the
                // pause report themselves.
                eventPlayer.pause();
                eventPlayer.seekTo(0);
                sendState(true);
                return;
            }
            sendState(false);
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException error) {
            // ExoPlayer retried under its load-error policy and gave up, such as in a dead zone. The
            // notification stays as paused, and Play prepares the item again at the same position.
            hasPlaybackError = true;
            if (player != null) {
                player.pause();
            }
        }
    }
}
