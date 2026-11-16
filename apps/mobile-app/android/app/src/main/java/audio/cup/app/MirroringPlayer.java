package audio.cup.app;

import android.net.Uri;
import android.os.Looper;
import android.os.SystemClock;
import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.SimpleBasePlayer;
import androidx.media3.common.util.UnstableApi;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

/**
 * The media session's player, which plays nothing: it mirrors the last state the page reported for
 * the WebView's {@code <audio>}, and turns every system command into a {@link Command} for the page.
 * Media3 reads the position from an extrapolating supplier, so the page reports only on playback
 * changes.
 */
@UnstableApi
final class MirroringPlayer extends SimpleBasePlayer {
    /** The skip interval of the notification's back and forward buttons, as in Cup's player. */
    static final long SKIP_MILLISECONDS = 15_000;

    /**
     * Stop must be advertised, or Media3 drops it from car head units, Android Auto and Wear OS. The
     * getters let the notification and lock screen read the title, duration and position.
     */
    private static final Commands AVAILABLE_COMMANDS = new Commands.Builder()
        .addAll(
            COMMAND_PLAY_PAUSE,
            COMMAND_STOP,
            COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
            COMMAND_SEEK_BACK,
            COMMAND_SEEK_FORWARD,
            COMMAND_GET_METADATA,
            COMMAND_GET_CURRENT_MEDIA_ITEM,
            COMMAND_GET_TIMELINE
        )
        .build();

    /** A command for the page, which acts on it as on the same command from a browser. */
    interface CommandListener {
        void onPlay();

        void onPause();

        void onStop();

        void onSeekTo(long positionMilliseconds);

        void onSeekBackward(long offsetMilliseconds);

        void onSeekForward(long offsetMilliseconds);
    }

    private final CommandListener commandListener;

    @Nullable
    private String title;

    @Nullable
    private Uri artworkUri;

    private long durationMilliseconds = C.TIME_UNSET;
    private long positionMilliseconds;
    /** When the page reported the position, by {@link SystemClock#elapsedRealtime()}. */
    private long positionReportedAt = SystemClock.elapsedRealtime();
    private float playbackRate = 1f;
    private boolean isPlaying;
    private boolean isWaiting;
    private boolean hasEnded;
    private State state;

    MirroringPlayer(Looper looper, CommandListener commandListener) {
        super(looper);
        this.commandListener = commandListener;
        state = buildState();
    }

    /** Whether an audiobook is loaded, which the page reports with its metadata. */
    boolean isLoaded() {
        return title != null;
    }

    void setMetadata(String title, @Nullable String artworkUrl) {
        this.title = title;
        this.artworkUri = artworkUrl == null ? null : Uri.parse(artworkUrl);
        update();
    }

    void setPlaybackState(boolean isPlaying, boolean isWaiting, boolean hasEnded) {
        positionMilliseconds = currentPositionMilliseconds();
        positionReportedAt = SystemClock.elapsedRealtime();
        this.isPlaying = isPlaying;
        this.isWaiting = isWaiting;
        this.hasEnded = hasEnded;
        update();
    }

    void setPositionState(long durationMilliseconds, long positionMilliseconds, float playbackRate) {
        this.durationMilliseconds = durationMilliseconds;
        this.positionMilliseconds = positionMilliseconds;
        positionReportedAt = SystemClock.elapsedRealtime();
        this.playbackRate = playbackRate;
        update();
    }

    /** Nothing is loaded any more: the session shows no audiobook, so Media3 removes the notification. */
    void clear() {
        title = null;
        artworkUri = null;
        durationMilliseconds = C.TIME_UNSET;
        positionMilliseconds = 0;
        positionReportedAt = SystemClock.elapsedRealtime();
        playbackRate = 1f;
        isPlaying = false;
        isWaiting = false;
        hasEnded = false;
        update();
    }

    @Override
    protected State getState() {
        return state;
    }

    // Each handler shows the command's effect at once and leaves the `<audio>` to the page, whose
    // next report corrects the mirror.

    @Override
    protected ListenableFuture<?> handleSetPlayWhenReady(boolean playWhenReady) {
        positionMilliseconds = currentPositionMilliseconds();
        positionReportedAt = SystemClock.elapsedRealtime();
        isPlaying = playWhenReady;
        if (playWhenReady) {
            // Play after the end starts over in the page; in the ready state Media3 returns the
            // service to the foreground.
            hasEnded = false;
        }
        update();
        if (playWhenReady) {
            commandListener.onPlay();
        } else {
            commandListener.onPause();
        }
        return Futures.immediateVoidFuture();
    }

    @Override
    protected ListenableFuture<?> handleStop() {
        // The page handles stop as a pause and keeps the audiobook loaded.
        positionMilliseconds = currentPositionMilliseconds();
        positionReportedAt = SystemClock.elapsedRealtime();
        isPlaying = false;
        update();
        commandListener.onStop();
        return Futures.immediateVoidFuture();
    }

    @Override
    protected ListenableFuture<?> handleSeek(int mediaItemIndex, long positionMs, @Player.Command int seekCommand) {
        long to = durationMilliseconds == C.TIME_UNSET ? Math.max(0, positionMs) : clamp(positionMs, durationMilliseconds);
        positionMilliseconds = to;
        positionReportedAt = SystemClock.elapsedRealtime();
        hasEnded = false;
        update();
        if (seekCommand == COMMAND_SEEK_BACK) {
            commandListener.onSeekBackward(SKIP_MILLISECONDS);
        } else if (seekCommand == COMMAND_SEEK_FORWARD) {
            commandListener.onSeekForward(SKIP_MILLISECONDS);
        } else {
            commandListener.onSeekTo(to);
        }
        return Futures.immediateVoidFuture();
    }

    private void update() {
        state = buildState();
        invalidateState();
    }

    private State buildState() {
        State.Builder builder = new State.Builder()
            .setAvailableCommands(AVAILABLE_COMMANDS)
            .setSeekBackIncrementMs(SKIP_MILLISECONDS)
            .setSeekForwardIncrementMs(SKIP_MILLISECONDS);
        if (!isLoaded()) {
            return builder.setPlaybackState(STATE_IDLE).setPlaylist(ImmutableList.of()).build();
        }

        MediaMetadata metadata = new MediaMetadata.Builder().setTitle(title).setArtworkUri(artworkUri).build();
        MediaItem mediaItem = new MediaItem.Builder().setMediaId("narration").setMediaMetadata(metadata).build();
        MediaItemData item = new MediaItemData.Builder(/* uid= */ "narration")
            .setMediaItem(mediaItem)
            .setDurationUs(durationMilliseconds == C.TIME_UNSET ? C.TIME_UNSET : durationMilliseconds * 1_000)
            .setIsSeekable(true)
            .build();
        // In the ready state while playing, Media3 extrapolates the position at the playback rate.
        return builder
            .setPlaylist(ImmutableList.of(item))
            .setCurrentMediaItemIndex(0)
            .setPlayWhenReady(isPlaying, PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setPlaybackState(hasEnded ? STATE_ENDED : isPlaying && isWaiting ? STATE_BUFFERING : STATE_READY)
            .setPlaybackParameters(new PlaybackParameters(playbackRate))
            .setContentPositionMs(positionMilliseconds)
            .build();
    }

    /** The position Media3 shows now, extrapolated from the last report while playing. */
    private long currentPositionMilliseconds() {
        if (!isPlaying || isWaiting || hasEnded) {
            return positionMilliseconds;
        }
        long elapsed = SystemClock.elapsedRealtime() - positionReportedAt;
        long position = positionMilliseconds + (long) (elapsed * playbackRate);
        return durationMilliseconds == C.TIME_UNSET ? position : clamp(position, durationMilliseconds);
    }

    private static long clamp(long position, long duration) {
        return Math.max(0, Math.min(position, duration));
    }
}
