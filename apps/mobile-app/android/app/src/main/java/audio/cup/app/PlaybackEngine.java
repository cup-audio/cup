package audio.cup.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
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
 * server refused them. The engine then drops its media item and reports a state with the
 * {@link ClosedReason} and the last position, which it keeps for {@code getState} until the next
 * load. It keeps the ended session's saves too ({@link EndedSession}), so a close with a save or a
 * load of another audiobook still saves a position the native stop could not.
 *
 * <p>Paused URLs expire by a delayed check while the process runs, and by an inexact alarm
 * ({@link ExpiryAlarmReceiver}) while the device sleeps or Android freezes Cup; every command and
 * every Play checks again.
 *
 * <p>Must be used on the main thread.
 */
@UnstableApi
final class PlaybackEngine {
    /** Receives the state after every change of the player, and after a native stop. */
    interface StateListener {
        void onState(JSObject state);
    }

    /** Why the engine ended its session without the page; {@code NativeClosedReason} on the page. */
    enum ClosedReason {
        /** The listener swiped Cup from recents while it was paused. */
        TASK_REMOVED("taskRemoved"),
        /** The listener swiped the notification away, after the service left the foreground. */
        NOTIFICATION_DISMISSED("notificationDismissed"),
        /** The listener pressed Close on the notification or the lock screen. */
        CLOSED("closed"),
        /** The URLs expired while paused, or the server refused the track URL. */
        TRACK_URL_EXPIRED("trackUrlExpired"),
        /** Android stopped the service for another reason. */
        SERVICE_STOPPED("serviceStopped");

        /** The reason as the page's `state` events name it. */
        final String wireName;

        ClosedReason(String wireName) {
            this.wireName = wireName;
        }
    }

    /** What closing for the page does with the position; {@code PositionOnClose} on the page. */
    enum PositionOnClose {
        /** Saves the position one last time. */
        SAVE,
        /** Saves nothing, since a save would race the audiobook's deletion. */
        DISCARD,
    }

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

    /**
     * Where the page just loaded an audiobook, until the player shows anything else or the page sends
     * its next command; null otherwise. The page shows that audiobook paused there already, and the
     * page receives the load's reports only after its next command: a Play on an audiobook that was
     * not loaded would show Pause, then this paused state, then Play's own report.
     */
    @Nullable
    private Long quietLoadPosition;

    /** Whether the listener heard playback at the last change, so the change to paused saves. */
    private boolean wasPlaying;

    /** What the last native stop reported, until the next load or close. */
    @Nullable
    private JSObject closedState;

    /** The saves of the session the last native stop ended, until the next load or close. */
    @Nullable
    private EndedSession endedSession;

    /** When the armed expiry alarm fires, in epoch milliseconds, or 0 without one. */
    private long expiryAlarmAt;

    /** What the page loads. */
    static final class LoadRequest {
        final String conversionId;
        final String subject;
        final SignedUrls urls;
        final ListeningPositions positions;
        final String title;
        @Nullable
        final String artworkUrl;
        final long durationMilliseconds;
        final long startPositionMilliseconds;

        LoadRequest(
            String conversionId,
            String subject,
            SignedUrls urls,
            ListeningPositions positions,
            String title,
            @Nullable String artworkUrl,
            long durationMilliseconds,
            long startPositionMilliseconds
        ) {
            this.conversionId = conversionId;
            this.subject = subject;
            this.urls = urls;
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
        SignedUrlExpiry expiry;
        /** Set right after construction, since its reports name this audiobook. */
        PositionSaves saves;

        Loaded(String conversionId, String subject, long durationMilliseconds, SignedUrlExpiry expiry) {
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
     * fetches nothing and shows no notification; in a running session, it replaces the item. It
     * reports nothing until the player shows more than the load, since the page shows it already.
     */
    void load(LoadRequest request) {
        MediaItem item = new MediaItem.Builder()
            .setMediaId(request.conversionId)
            .setUri(request.urls.trackUrl)
            .setMediaMetadata(
                new MediaMetadata.Builder()
                    .setTitle(request.title)
                    // Without an artist, System UI on Android 17 shows "null" under the title.
                    .setArtist(context.getString(R.string.app_name))
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
        EndedSession ended = endedSession;
        // Loading the ended audiobook again starts from where the page holds it, which Play saves.
        if (ended != null && !ended.conversionId.equals(request.conversionId)) {
            ended.saveIfUnsaved(System.currentTimeMillis());
        }
        Loaded audiobook = new Loaded(
            request.conversionId,
            request.subject,
            request.durationMilliseconds,
            request.urls.expiry()
        );
        audiobook.saves = new PositionSaves(request.positions, request.urls.positionUrl, new SaveServices(audiobook));
        loaded = audiobook;
        hasPlaybackError = false;
        closedState = null;
        endedSession = null;
        // The pause below ends the previous audiobook's playback, whose position is saved already.
        wasPlaying = false;
        handler.removeCallbacks(saveCheck);
        // Loading another audiobook leaves it paused, as on the web.
        exoPlayer.pause();
        exoPlayer.setMediaItem(item, request.startPositionMilliseconds);
        quietLoadPosition = request.startPositionMilliseconds;
        updateExpiryCheck();
    }

    /** Prepares and plays; the first Play starts the service. Returns false without a loaded audiobook. */
    boolean play() {
        endQuietLoad();
        ExoPlayer exoPlayer = loadedPlayer();
        if (exoPlayer == null || sessionPlayer == null) {
            return false;
        }
        if (stopIfExpiredWhilePaused()) {
            // The closed state tells the page, whose next Play renews the URLs.
            return true;
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
        endQuietLoad();
        ExoPlayer exoPlayer = loadedPlayer();
        if (exoPlayer == null) {
            return false;
        }
        if (stopIfExpiredWhilePaused()) {
            return true;
        }
        exoPlayer.pause();
        return true;
    }

    boolean seekTo(long positionMilliseconds) {
        endQuietLoad();
        ExoPlayer exoPlayer = loadedPlayer();
        if (exoPlayer == null) {
            return false;
        }
        if (stopIfExpiredWhilePaused()) {
            return true;
        }
        exoPlayer.seekTo(clampToTrack(positionMilliseconds));
        return true;
    }

    /** Skips from ExoPlayer's own position, which can be ahead of the page's last report. */
    boolean skipBy(long deltaMilliseconds) {
        endQuietLoad();
        ExoPlayer exoPlayer = loadedPlayer();
        if (exoPlayer == null) {
            return false;
        }
        if (stopIfExpiredWhilePaused()) {
            return true;
        }
        exoPlayer.seekTo(clampToTrack(exoPlayer.getCurrentPosition() + deltaMilliseconds));
        return true;
    }

    /** Replaces the URLs, keeping the position. */
    boolean replaceUrls(SignedUrls urls) {
        endQuietLoad();
        ExoPlayer exoPlayer = loadedPlayer();
        Loaded audiobook = loaded;
        if (exoPlayer == null || audiobook == null) {
            return false;
        }
        audiobook.expiry = urls.expiry();
        audiobook.saves.replacePositionUrl(urls.positionUrl);
        MediaItem current = exoPlayer.getCurrentMediaItem();
        if (current != null) {
            exoPlayer.setMediaItem(current.buildUpon().setUri(urls.trackUrl).build(), exoPlayer.getCurrentPosition());
        }
        updateExpiryCheck();
        return true;
    }

    /**
     * Ends the session for the page: on sign-out or a change of the signed-in user, which saves the
     * position one last time, or without saving when the loaded audiobook is deleted or a starting
     * page cannot take the session over, since a save would race the deletion. After a native stop,
     * the save is the ended session's, if its own failed. Reports nothing.
     */
    void close(PositionOnClose position) {
        endQuietLoad();
        ExoPlayer exoPlayer = player;
        Loaded audiobook = loaded;
        if (exoPlayer != null && audiobook != null) {
            if (position == PositionOnClose.SAVE) {
                // The position URL authorizes this save after the listener's session is gone.
                audiobook.saves.save(exoPlayer.getCurrentPosition());
            }
            audiobook.saves.close();
        }
        if (endedSession != null && position == PositionOnClose.SAVE) {
            endedSession.saveIfUnsaved(System.currentTimeMillis());
        }
        closedState = null;
        endedSession = null;
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
     * removes the notification, and reports the closed state with the last position.
     */
    void stopNatively(ClosedReason reason) {
        if (player == null || loaded == null) {
            return;
        }
        reportClosed(reason);
        releasePlayer();
    }

    /**
     * The service stopped and released `servicePlayer`. When the engine did not stop it, Android did,
     * and the session is over all the same.
     */
    void onServiceDestroyed(Player servicePlayer) {
        if (servicePlayer != sessionPlayer || loaded == null || player == null) {
            return;
        }
        reportClosed(ClosedReason.SERVICE_STOPPED);
        // The service released the player already.
        forgetPlayer();
    }

    /** The expiry alarm fired: a paused session whose URLs expired ends. */
    void onExpiryAlarm() {
        expiryAlarmAt = 0;
        stopIfExpiredWhilePaused();
    }

    /**
     * Before a native stop, keeps the session's saves as the ended session, which tries one final
     * save, and reports the closed state with the last position. If that save fails, the page's
     * cached audiobook shows the position, and the page's close or next load tries again.
     */
    private void reportClosed(ClosedReason reason) {
        ExoPlayer exoPlayer = player;
        Loaded audiobook = loaded;
        if (exoPlayer == null || audiobook == null) {
            throw new IllegalStateException("The engine has no session to close.");
        }
        long positionMilliseconds = exoPlayer.getCurrentPosition();
        JSObject state = readLiveState(false);
        state.put("isPlaying", false);
        state.put("isBuffering", false);
        // Only expired URLs need the page to act: its next Play renews them.
        state.put("error", reason == ClosedReason.TRACK_URL_EXPIRED ? reason.wireName : JSObject.NULL);
        state.put("closedReason", reason.wireName);

        EndedSession ended = new EndedSession(audiobook.conversionId, audiobook.saves, audiobook.expiry, positionMilliseconds);
        ended.saveIfUnsaved(System.currentTimeMillis());
        endedSession = ended;
        closedState = state;
        if (listener != null) {
            listener.onState(state);
        }
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
        cancelExpiryAlarm();
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

    /**
     * While the player is paused, checks again when the URLs expire: by a delayed check, whose clock
     * stops while the device sleeps, and by an inexact alarm, which Android delivers once the device
     * is awake again, also to a frozen Cup.
     */
    private void updateExpiryCheck() {
        handler.removeCallbacks(expiryCheck);
        Loaded audiobook = loaded;
        if (player == null || audiobook == null || player.getPlayWhenReady()) {
            cancelExpiryAlarm();
            return;
        }
        handler.postDelayed(expiryCheck, audiobook.expiry.millisecondsUntilExpiry(System.currentTimeMillis()));
        setExpiryAlarm(audiobook.expiry.expiresAt());
    }

    /** Ends a paused session whose URLs expired, and returns whether it did. */
    private boolean stopIfExpiredWhilePaused() {
        Loaded audiobook = loaded;
        if (player == null || audiobook == null || player.getPlayWhenReady()) {
            return false;
        }
        if (!audiobook.expiry.hasExpired(System.currentTimeMillis())) {
            updateExpiryCheck();
            return false;
        }
        stopNatively(ClosedReason.TRACK_URL_EXPIRED);
        return true;
    }

    /**
     * A non-wakeup alarm, inexact, so it needs no exact-alarm permission. Not set again for the same
     * time, since the player's state changes often while paused.
     */
    private void setExpiryAlarm(long expiresAt) {
        if (expiryAlarmAt == expiresAt) {
            return;
        }
        expiryAlarmAt = expiresAt;
        context.getSystemService(AlarmManager.class).set(AlarmManager.RTC, expiresAt, expiryAlarmIntent());
    }

    private void cancelExpiryAlarm() {
        if (expiryAlarmAt == 0) {
            return;
        }
        expiryAlarmAt = 0;
        context.getSystemService(AlarmManager.class).cancel(expiryAlarmIntent());
    }

    private PendingIntent expiryAlarmIntent() {
        Intent intent = new Intent(context, ExpiryAlarmReceiver.class);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
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
        state.put("closedReason", JSObject.NULL);
        state.put("positionSave", readPositionSave(audiobook.saves));
        return state;
    }

    /** How the saves fare, as {@code NativePositionSave} on the page. */
    private static JSObject readPositionSave(PositionSaves saves) {
        JSObject positionSave = new JSObject();
        positionSave.put("status", saves.getStatus().wireName);
        if (saves.getStatus() == PositionSaves.Status.REFUSED) {
            positionSave.put("refusal", saves.getRefusalDetail());
        }
        return positionSave;
    }

    /**
     * Whether the player shows only what the page's load set, paused at its start position, which the
     * page shows already. Anything else, such as Play or a seek from the notification, ends the quiet.
     */
    private boolean showsOnlyTheLoad(Player exoPlayer) {
        Long startPositionMilliseconds = quietLoadPosition;
        if (startPositionMilliseconds == null) {
            return false;
        }
        if (
            isPlayingForListener(exoPlayer) ||
            exoPlayer.getPlayerError() != null ||
            exoPlayer.getCurrentPosition() != startPositionMilliseconds
        ) {
            endQuietLoad();
            return false;
        }
        return true;
    }

    /** The page's command, or a change beyond the load, shows its own state from here on. */
    private void endQuietLoad() {
        quietLoadPosition = null;
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
                SignedUrlExpiry.isUrlRejection(((HttpDataSource.InvalidResponseCodeException) cause).responseCode)
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

    /** Stops natively for `reason` outside the player's own callback, which must not release it. */
    private void stopSoon(ClosedReason reason) {
        ExoPlayer exoPlayer = player;
        if (exoPlayer == null) {
            return;
        }
        isStopping = true;
        exoPlayer.pause();
        handler.post(() -> {
            if (player == exoPlayer) {
                isStopping = false;
                stopNatively(reason);
            }
        });
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
            if (
                events.contains(Player.EVENT_PLAY_WHEN_READY_CHANGED) &&
                eventPlayer.getPlayWhenReady() &&
                loaded != null &&
                loaded.expiry.hasExpired(System.currentTimeMillis())
            ) {
                // Play from the media session after the URLs expired while paused, before a check
                // caught it.
                stopSoon(ClosedReason.TRACK_URL_EXPIRED);
                return;
            }
            followPlayback(isPlayingForListener(eventPlayer));
            if (!showsOnlyTheLoad(eventPlayer)) {
                sendState(false);
            }
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
                // Only a newly signed URL plays, which only the page fetches.
                stopSoon(ClosedReason.TRACK_URL_EXPIRED);
                return;
            }
            // ExoPlayer retried under its load-error policy and gave up, such as in a dead zone. The
            // notification stays as paused, and Play prepares the item again at the same position.
            hasPlaybackError = true;
            exoPlayer.pause();
        }
    }
}
