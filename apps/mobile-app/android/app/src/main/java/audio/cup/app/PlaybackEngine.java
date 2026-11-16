package audio.cup.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy;
import com.getcapacitor.JSObject;
import java.util.Locale;

/**
 * The narration track's engine in the Android app: one Media3 ExoPlayer for the whole process, so
 * a session outlives the activity and its WebView, and a page that starts while it plays takes it
 * over. The {@link MediaPlaybackPlugin} drives it for the page, and the system's media controls
 * reach it through the {@link MediaPlaybackService}'s session.
 *
 * <p>The engine is the only writer of the listening position in the app, through the signed
 * position URL ({@link PositionSaves}), so it saves while the page is suspended: every
 * {@link PositionSaves#SAVE_INTERVAL_MILLISECONDS} while playing, and at once on pause, seek, the
 * end, which returns to the start, and close, and before another audiobook replaces the loaded one.
 *
 * <p>The session ends without the page when the listener swipes Cup from recents while paused,
 * swipes the notification away, or the URLs can no longer play: they expired while paused, or the
 * server refused them. The engine then drops its media item and reports a {@code closed} state with
 * the reason and the last position, which it keeps for {@code getState} until the next load.
 *
 * <p>Must be used on the main thread.
 */
@UnstableApi
final class PlaybackEngine {
    /** Receives the state after every change of the player, and after a native stop. */
    interface StateListener {
        void onState(JSObject state);
    }

    /** The listener swiped Cup from recents while it was paused. */
    static final String CLOSED_TASK_REMOVED = "taskRemoved";
    /** The listener swiped the notification away, after the service left the foreground. */
    static final String CLOSED_NOTIFICATION_DISMISSED = "notificationDismissed";
    /** The URLs expired while paused, or the server refused the track URL. */
    static final String CLOSED_TRACK_URL_EXPIRED = "trackUrlExpired";
    /** Android stopped the service for another reason. */
    static final String CLOSED_SERVICE_STOPPED = "serviceStopped";

    /** How far the notification's back and forward buttons skip, as Cup's player does. */
    private static final long SKIP_MILLISECONDS = 15_000;
    /** How often a playing session checks whether a save is due, like a media element's updates. */
    private static final long SAVE_CHECK_INTERVAL_MILLISECONDS = 500;

    @Nullable
    private static PlaybackEngine instance;

    private final Context context;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable expiryCheck = this::stopIfExpiredWhilePaused;
    private final Runnable saveCheck = this::saveIfDueWhilePlaying;
    private final PositionUrlWriter positionWriter = new PositionUrlWriter(handler);

    @Nullable
    private StateListener listener;

    @Nullable
    private ExoPlayer player;

    @Nullable
    private SessionPlayer sessionPlayer;

    @Nullable
    private Loaded loaded;

    /**
     * The last load failed, and ExoPlayer paused; the next Play prepares the item again. Cleared once
     * ExoPlayer has no error, whoever prepared it.
     */
    private boolean hasPlaybackError;

    /** A native stop is on its way, so the states until then report nothing. */
    private boolean isStopping;

    /** Whether the listener heard playback at the last change, so the change to paused saves. */
    private boolean wasPlaying;

    /** What the last native stop reported, until the next load or close. */
    @Nullable
    private JSObject closedState;

    /** What the page loads. */
    static final class LoadRequest {
        final String conversionId;
        final String subject;
        final String trackUrl;
        final String positionUrl;
        final long urlsIssuedAt;
        final ListeningPositions positions;
        final String title;
        @Nullable
        final String artworkUrl;
        final long durationMilliseconds;
        final long startPositionMilliseconds;

        LoadRequest(
            String conversionId,
            String subject,
            String trackUrl,
            String positionUrl,
            long urlsIssuedAt,
            ListeningPositions positions,
            String title,
            @Nullable String artworkUrl,
            long durationMilliseconds,
            long startPositionMilliseconds
        ) {
            this.conversionId = conversionId;
            this.subject = subject;
            this.trackUrl = trackUrl;
            this.positionUrl = positionUrl;
            this.urlsIssuedAt = urlsIssuedAt;
            this.positions = positions;
            this.title = title;
            this.artworkUrl = artworkUrl;
            this.durationMilliseconds = durationMilliseconds;
            this.startPositionMilliseconds = startPositionMilliseconds;
        }
    }

    /** The audiobook loaded into the player. */
    private static final class Loaded {
        final String conversionId;
        final String subject;
        final long durationMilliseconds;
        TrackUrlExpiry expiry;
        /** Set right after construction, since its reports name this audiobook. */
        PositionSaves saves;

        Loaded(String conversionId, String subject, long durationMilliseconds, TrackUrlExpiry expiry) {
            this.conversionId = conversionId;
            this.subject = subject;
            this.durationMilliseconds = durationMilliseconds;
            this.expiry = expiry;
        }
    }

    private PlaybackEngine(Context context) {
        this.context = context;
        // A failed save is retried as soon as the device has a network again.
        ConnectivityManager connectivity = context.getSystemService(ConnectivityManager.class);
        connectivity.registerDefaultNetworkCallback(
            new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(@NonNull Network network) {
                    handler.post(PlaybackEngine.this::reconnected);
                }
            }
        );
    }

    static PlaybackEngine get(Context context) {
        if (instance == null) {
            instance = new PlaybackEngine(context.getApplicationContext());
        }
        return instance;
    }

    /** The plugin of the current page, which forwards the states to it; one at a time. */
    void setListener(@Nullable StateListener listener) {
        this.listener = listener;
    }

    void clearListener(StateListener listener) {
        if (this.listener == listener) {
            this.listener = null;
        }
    }

    /**
     * Sets the audiobook as the media item, paused. While the player was never prepared, this
     * fetches nothing and shows no notification; in a running session, it replaces the item.
     */
    void load(LoadRequest request) {
        MediaItem item = new MediaItem.Builder()
            .setMediaId(request.conversionId)
            .setUri(request.trackUrl)
            .setMediaMetadata(
                new MediaMetadata.Builder()
                    .setTitle(request.title)
                    .setArtworkUri(request.artworkUrl == null ? null : Uri.parse(request.artworkUrl))
                    .setDurationMs(request.durationMilliseconds)
                    .build()
            )
            .build();
        ExoPlayer exoPlayer = ensurePlayer();
        Loaded previous = loaded;
        if (previous != null) {
            // The previous audiobook's position, before its media item is replaced.
            previous.saves.save(exoPlayer.getCurrentPosition());
            previous.saves.close();
        }
        Loaded audiobook = new Loaded(
            request.conversionId,
            request.subject,
            request.durationMilliseconds,
            new TrackUrlExpiry(request.urlsIssuedAt, PlaybackTimings.signedUrlLifetimeMilliseconds)
        );
        audiobook.saves = new PositionSaves(request.positions, request.positionUrl, new SaveServices(audiobook));
        loaded = audiobook;
        hasPlaybackError = false;
        closedState = null;
        // The pause below ends the previous audiobook's playback, whose position is saved already.
        wasPlaying = false;
        handler.removeCallbacks(saveCheck);
        // Loading another audiobook leaves it paused, as on the web.
        exoPlayer.pause();
        exoPlayer.setMediaItem(item, request.startPositionMilliseconds);
        sendState(false);
        updateExpiryCheck();
    }

    /** Prepares and plays; the first Play starts the service. Returns false without a loaded audiobook. */
    boolean play() {
        ExoPlayer exoPlayer = loadedPlayer();
        if (exoPlayer == null || sessionPlayer == null) {
            return false;
        }
        hasPlaybackError = false;
        if (exoPlayer.getPlaybackState() == Player.STATE_IDLE) {
            // The first Play, or Play after a failed load, which continues where it stopped.
            exoPlayer.prepare();
        }
        exoPlayer.play();
        MediaPlaybackService.start(context, sessionPlayer);
        return true;
    }

    boolean pause() {
        ExoPlayer exoPlayer = loadedPlayer();
        if (exoPlayer == null) {
            return false;
        }
        exoPlayer.pause();
        return true;
    }

    boolean seekTo(long positionMilliseconds) {
        ExoPlayer exoPlayer = loadedPlayer();
        if (exoPlayer == null) {
            return false;
        }
        exoPlayer.seekTo(clampToTrack(positionMilliseconds));
        return true;
    }

    /** Skips from ExoPlayer's own position, which can be ahead of the page's last report. */
    boolean skipBy(long deltaMilliseconds) {
        ExoPlayer exoPlayer = loadedPlayer();
        if (exoPlayer == null) {
            return false;
        }
        exoPlayer.seekTo(clampToTrack(exoPlayer.getCurrentPosition() + deltaMilliseconds));
        return true;
    }

    /** Replaces the URLs, which the page fetched at `urlsIssuedAt`, keeping the position. */
    boolean replaceUrls(String trackUrl, String positionUrl, long urlsIssuedAt) {
        ExoPlayer exoPlayer = loadedPlayer();
        Loaded audiobook = loaded;
        if (exoPlayer == null || audiobook == null) {
            return false;
        }
        audiobook.expiry = new TrackUrlExpiry(urlsIssuedAt, PlaybackTimings.signedUrlLifetimeMilliseconds);
        audiobook.saves.replacePositionUrl(positionUrl);
        MediaItem current = exoPlayer.getCurrentMediaItem();
        if (current != null) {
            exoPlayer.setMediaItem(current.buildUpon().setUri(trackUrl).build(), exoPlayer.getCurrentPosition());
        }
        updateExpiryCheck();
        return true;
    }

    /**
     * Ends the session for the page: on sign-out or a change of the signed-in user, which saves the
     * position one last time, or without saving when the loaded audiobook is deleted or a starting
     * page cannot take the session over, since a save would race the deletion. Reports nothing.
     */
    void close(boolean shouldSave) {
        ExoPlayer exoPlayer = player;
        Loaded audiobook = loaded;
        if (exoPlayer != null && audiobook != null) {
            if (shouldSave) {
                // The position URL authorizes this save after the listener's session is gone.
                audiobook.saves.save(exoPlayer.getCurrentPosition());
            }
            audiobook.saves.close();
        }
        closedState = null;
        releasePlayer();
    }

    /** The connection may be back: the device has a network again, or Cup returned to the foreground. */
    void reconnected() {
        if (loaded != null) {
            loaded.saves.reconnected();
        }
    }

    /** The current state, the state of the last native stop, or null without either. */
    @Nullable
    JSObject readState() {
        return player != null && loaded != null ? readLiveState(false) : closedState;
    }

    /**
     * Ends the session without the page, for `reason`: drops the media item, stops the service, which
     * removes the notification, and reports a `closed` state with the last position.
     */
    void stopNatively(String reason) {
        if (player == null || loaded == null) {
            return;
        }
        finishSaves(player.getCurrentPosition());
        JSObject state = readLiveState(false);
        state.put("isPlaying", false);
        state.put("isBuffering", false);
        state.put("error", CLOSED_TRACK_URL_EXPIRED.equals(reason) ? "trackUrlExpired" : JSObject.NULL);
        state.put("closed", true);
        state.put("closedReason", reason);
        releasePlayer();
        closedState = state;
        if (listener != null) {
            listener.onState(state);
        }
    }

    /**
     * The service stopped and released `servicePlayer`. When the engine did not stop it, Android did,
     * and the session is over all the same.
     */
    void onServiceDestroyed(Player servicePlayer) {
        if (servicePlayer != sessionPlayer || loaded == null || player == null) {
            return;
        }
        finishSaves(player.getCurrentPosition());
        JSObject state = readLiveState(false);
        state.put("isPlaying", false);
        state.put("isBuffering", false);
        state.put("closed", true);
        state.put("closedReason", CLOSED_SERVICE_STOPPED);
        // The service released the player already.
        forgetPlayer();
        closedState = state;
        if (listener != null) {
            listener.onState(state);
        }
    }

    /**
     * Before a native stop, tries one final save unless the last one succeeded or the URLs expired.
     * If it fails, the position is lost here, but the `closed` state reports it to the page.
     */
    private void finishSaves(long positionMilliseconds) {
        Loaded audiobook = loaded;
        if (audiobook == null) {
            return;
        }
        if (audiobook.saves.isFailing() && !audiobook.expiry.hasExpired(System.currentTimeMillis())) {
            audiobook.saves.save(positionMilliseconds);
        }
        audiobook.saves.close();
    }

    private ExoPlayer ensurePlayer() {
        if (player != null) {
            return player;
        }
        ExoPlayer exoPlayer = new ExoPlayer.Builder(context)
            .setAudioAttributes(
                new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(),
                // With speech, ExoPlayer pauses for a duck request instead of lowering the volume.
                true
            )
            .setHandleAudioBecomingNoisy(true)
            .setSeekBackIncrementMs(SKIP_MILLISECONDS)
            .setSeekForwardIncrementMs(SKIP_MILLISECONDS)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(context).setLoadErrorHandlingPolicy(new TrackLoadErrorPolicy()))
            .build();
        exoPlayer.addListener(new StateReporter());
        player = exoPlayer;
        sessionPlayer = new SessionPlayer(exoPlayer);
        return exoPlayer;
    }

    private void releasePlayer() {
        ExoPlayer exoPlayer = player;
        SessionPlayer wrapper = sessionPlayer;
        forgetPlayer();
        if (exoPlayer == null || wrapper == null) {
            return;
        }
        if (!MediaPlaybackService.stop(wrapper)) {
            wrapper.release();
            exoPlayer.release();
        }
    }

    private void forgetPlayer() {
        player = null;
        sessionPlayer = null;
        loaded = null;
        hasPlaybackError = false;
        isStopping = false;
        wasPlaying = false;
        handler.removeCallbacks(expiryCheck);
        handler.removeCallbacks(saveCheck);
    }

    @Nullable
    private ExoPlayer loadedPlayer() {
        return loaded == null ? null : player;
    }

    /** Short of the track's end, as Cup's player seeks. */
    private long clampToTrack(long positionMilliseconds) {
        long duration = loaded == null ? Long.MAX_VALUE : loaded.durationMilliseconds;
        return Math.max(0, Math.min(positionMilliseconds, duration - 1));
    }

    /** While the player is paused, checks again when the URLs expire. */
    private void updateExpiryCheck() {
        handler.removeCallbacks(expiryCheck);
        Loaded audiobook = loaded;
        if (player == null || audiobook == null || player.getPlayWhenReady()) {
            return;
        }
        handler.postDelayed(expiryCheck, audiobook.expiry.millisecondsUntilExpiry(System.currentTimeMillis()));
    }

    private void stopIfExpiredWhilePaused() {
        Loaded audiobook = loaded;
        if (player == null || audiobook == null || player.getPlayWhenReady()) {
            return;
        }
        if (audiobook.expiry.hasExpired(System.currentTimeMillis())) {
            stopNatively(CLOSED_TRACK_URL_EXPIRED);
        } else {
            updateExpiryCheck();
        }
    }

    private void saveIfDueWhilePlaying() {
        if (player == null || loaded == null || !wasPlaying) {
            return;
        }
        loaded.saves.saveIfDue(player.getCurrentPosition());
        handler.postDelayed(saveCheck, SAVE_CHECK_INTERVAL_MILLISECONDS);
    }

    /** Saves when the listener stops hearing playback, and starts or stops the saves during it. */
    private void followPlayback(boolean isPlaying) {
        ExoPlayer exoPlayer = player;
        Loaded audiobook = loaded;
        if (exoPlayer == null || audiobook == null || isPlaying == wasPlaying) {
            return;
        }
        wasPlaying = isPlaying;
        handler.removeCallbacks(saveCheck);
        if (isPlaying) {
            handler.post(saveCheck);
        } else {
            // A pause, a call, a failed load or headphones disconnecting.
            audiobook.saves.save(exoPlayer.getCurrentPosition());
        }
    }

    private void sendState(boolean hasEnded) {
        if (player == null || loaded == null || isStopping || listener == null) {
            return;
        }
        listener.onState(readLiveState(hasEnded));
    }

    private JSObject readLiveState(boolean hasEnded) {
        ExoPlayer exoPlayer = player;
        Loaded audiobook = loaded;
        if (exoPlayer == null || audiobook == null) {
            throw new IllegalStateException("The engine has no loaded audiobook to report.");
        }
        int playbackState = exoPlayer.getPlaybackState();
        boolean isPlaying = isPlayingForListener(exoPlayer);
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
        state.put("closed", false);
        state.put("closedReason", JSObject.NULL);
        PositionSaves saves = audiobook.saves;
        String refusal = saves.getRefusalDetail();
        Long failingSince = saves.getFailingSince();
        state.put("positionSave", saves.getStatus().name().toLowerCase(Locale.ROOT));
        state.put("positionSaveRefusal", refusal == null ? JSObject.NULL : refusal);
        state.put("positionSaveFailingSince", failingSince == null ? JSObject.NULL : failingSince);
        return state;
    }

    /** Paused for a transient loss of audio focus, such as a call, ExoPlayer still wants to play. */
    private boolean isPlayingForListener(Player exoPlayer) {
        return (
            exoPlayer.getPlayWhenReady() &&
            exoPlayer.getPlaybackSuppressionReason() == Player.PLAYBACK_SUPPRESSION_REASON_NONE &&
            exoPlayer.getPlaybackState() != Player.STATE_ENDED &&
            !hasPlaybackError
        );
    }

    /** Whether the server refused the signed URL of a request that failed with `error`. */
    private static boolean isUrlRejection(@Nullable Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (
                cause instanceof HttpDataSource.InvalidResponseCodeException &&
                TrackUrlExpiry.isUrlRejection(((HttpDataSource.InvalidResponseCodeException) cause).responseCode)
            ) {
                return true;
            }
        }
        return false;
    }

    /** Writes `audiobook`'s saves through its position URL, and reports them while it is loaded. */
    private final class SaveServices implements PositionSaves.Services {
        private final Loaded audiobook;

        SaveServices(Loaded audiobook) {
            this.audiobook = audiobook;
        }

        @Override
        public long now() {
            return System.currentTimeMillis();
        }

        @Override
        public void write(String positionUrl, ListeningPosition position, PositionSaves.WriteCallback callback) {
            positionWriter.write(positionUrl, position, callback);
        }

        @Override
        public Runnable setRetryTimer(Runnable callback, long delayMilliseconds) {
            handler.postDelayed(callback, delayMilliseconds);
            return () -> handler.removeCallbacks(callback);
        }

        @Override
        public void onSaveStateChanged() {
            if (loaded == audiobook) {
                sendState(false);
            }
        }
    }

    /**
     * ExoPlayer's default policy retries a refused track request like any other failure, so playback
     * would continue from the buffer and fail only minutes later. A refused URL never works again.
     */
    private static final class TrackLoadErrorPolicy extends DefaultLoadErrorHandlingPolicy {
        @Override
        public long getRetryDelayMsFor(@NonNull LoadErrorInfo loadErrorInfo) {
            return isUrlRejection(loadErrorInfo.exception) ? C.TIME_UNSET : super.getRetryDelayMsFor(loadErrorInfo);
        }
    }

    /** Reports every change of the player. */
    private final class StateReporter implements Player.Listener {
        @Override
        public void onEvents(@NonNull Player eventPlayer, @NonNull Player.Events events) {
            if (eventPlayer != player) {
                return;
            }
            if (eventPlayer.getPlayerError() == null) {
                // Prepared again: by the page's Play, or by the media session, which prepares an idle
                // player itself for Play from the notification, a media key or a headset.
                hasPlaybackError = false;
            }
            if (eventPlayer.getPlaybackState() == Player.STATE_ENDED) {
                // A finished audiobook starts over the next time, as in Cup's player. The seek and the
                // pause report themselves, and the seek saves the start.
                wasPlaying = false;
                handler.removeCallbacks(saveCheck);
                eventPlayer.pause();
                eventPlayer.seekTo(0);
                sendState(true);
                return;
            }
            followPlayback(isPlayingForListener(eventPlayer));
            sendState(false);
            updateExpiryCheck();
        }

        @Override
        public void onPositionDiscontinuity(
            @NonNull Player.PositionInfo oldPosition,
            @NonNull Player.PositionInfo newPosition,
            int reason
        ) {
            // The page's seeks and skips, the notification's buttons and seek bar, and the return to
            // the start at the end. Seeks before the first Play count too, while ExoPlayer is idle.
            if (reason == Player.DISCONTINUITY_REASON_SEEK && loaded != null) {
                loaded.saves.save(newPosition.positionMs);
            }
        }

        @Override
        public void onPlayerError(@NonNull PlaybackException error) {
            ExoPlayer exoPlayer = player;
            if (exoPlayer == null) {
                return;
            }
            if (isUrlRejection(error)) {
                // Only a newly signed URL plays, which only the page fetches. Released outside the
                // player's own callback.
                isStopping = true;
                exoPlayer.pause();
                handler.post(() -> {
                    if (player == exoPlayer) {
                        isStopping = false;
                        stopNatively(CLOSED_TRACK_URL_EXPIRED);
                    }
                });
                return;
            }
            // ExoPlayer retried under its load-error policy and gave up, such as in a dead zone. The
            // notification stays as paused, and Play prepares the item again at the same position.
            hasPlaybackError = true;
            exoPlayer.pause();
        }
    }
}
