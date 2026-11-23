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

@UnstableApi
final class PlaybackEngine {
    interface StateListener {
        void onState(JSObject state);
    }

    enum ClosedReason {
        TASK_REMOVED("taskRemoved"),
        NOTIFICATION_DISMISSED("notificationDismissed"),
        CLOSED("closed"),
        TRACK_URL_EXPIRED("trackUrlExpired"),
        SERVICE_STOPPED("serviceStopped");

        final String wireName;

        ClosedReason(String wireName) {
            this.wireName = wireName;
        }
    }

    enum PositionOnClose {
        SAVE,
        DISCARD,
    }

    private static final long SKIP_MILLISECONDS = 15_000;
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

    private boolean hasPlaybackError;

    private boolean isStopping;

    @Nullable
    private Long unreportedLoadPosition;

    private boolean wasPlaying;

    @Nullable
    private JSObject closedState;

    @Nullable
    private EndedSession endedSession;

    private long expiryAlarmAt;

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

    private static final class Loaded {
        final String conversionId;
        final String subject;
        final long durationMilliseconds;
        SignedUrlExpiry expiry;
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

    void setListener(@Nullable StateListener listener) {
        this.listener = listener;
    }

    void clearListener(StateListener listener) {
        if (this.listener == listener) {
            this.listener = null;
        }
    }

    void load(LoadRequest request) {
        MediaItem item = new MediaItem.Builder()
            .setMediaId(request.conversionId)
            .setUri(request.urls.trackUrl)
            .setMediaMetadata(
                new MediaMetadata.Builder()
                    .setTitle(request.title)
                    .setArtist(context.getString(R.string.app_name))
                    .setArtworkUri(request.artworkUrl == null ? null : Uri.parse(request.artworkUrl))
                    .setDurationMs(request.durationMilliseconds)
                    .build()
            )
            .build();
        ExoPlayer exoPlayer = ensurePlayer();
        Loaded previous = loaded;
        if (previous != null) {
            previous.saves.save(exoPlayer.getCurrentPosition());
            previous.saves.close();
        }
        EndedSession ended = endedSession;
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
        wasPlaying = false;
        handler.removeCallbacks(saveCheck);
        exoPlayer.pause();
        exoPlayer.setMediaItem(item, request.startPositionMilliseconds);
        unreportedLoadPosition = request.startPositionMilliseconds;
        updateExpiryCheck();
    }

    boolean play() {
        endUnreportedLoad();
        ExoPlayer exoPlayer = loadedPlayer();
        if (exoPlayer == null || sessionPlayer == null) {
            return false;
        }
        if (stopIfExpiredWhilePaused()) {
            return true;
        }
        hasPlaybackError = false;
        if (exoPlayer.getPlaybackState() == Player.STATE_IDLE) {
            exoPlayer.prepare();
        }
        exoPlayer.play();
        MediaPlaybackService.start(context, sessionPlayer);
        return true;
    }

    boolean pause() {
        endUnreportedLoad();
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
        endUnreportedLoad();
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

    boolean skipBy(long deltaMilliseconds) {
        endUnreportedLoad();
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

    boolean replaceUrls(SignedUrls urls) {
        endUnreportedLoad();
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

    void close(PositionOnClose position) {
        endUnreportedLoad();
        ExoPlayer exoPlayer = player;
        Loaded audiobook = loaded;
        if (exoPlayer != null && audiobook != null) {
            if (position == PositionOnClose.SAVE) {
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

    void reconnected() {
        if (loaded != null) {
            loaded.saves.reconnected();
        }
    }

    @Nullable
    JSObject readState() {
        return player != null && loaded != null ? readLiveState(false) : closedState;
    }

    void stopNatively(ClosedReason reason) {
        if (player == null || loaded == null) {
            return;
        }
        reportClosed(reason);
        releasePlayer();
    }

    void onServiceDestroyed(Player servicePlayer) {
        if (servicePlayer != sessionPlayer || loaded == null || player == null) {
            return;
        }
        reportClosed(ClosedReason.SERVICE_STOPPED);
        forgetPlayer();
    }

    void onExpiryAlarm() {
        expiryAlarmAt = 0;
        stopIfExpiredWhilePaused();
    }

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
        endUnreportedLoad();
        handler.removeCallbacks(expiryCheck);
        handler.removeCallbacks(saveCheck);
        cancelExpiryAlarm();
    }

    @Nullable
    private ExoPlayer loadedPlayer() {
        return loaded == null ? null : player;
    }

    private long clampToTrack(long positionMilliseconds) {
        long duration = loaded == null ? Long.MAX_VALUE : loaded.durationMilliseconds;
        return Math.max(0, Math.min(positionMilliseconds, duration - 1));
    }

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

    private static JSObject readPositionSave(PositionSaves saves) {
        JSObject positionSave = new JSObject();
        positionSave.put("status", saves.getStatus().wireName);
        if (saves.getStatus() == PositionSaves.Status.REFUSED) {
            positionSave.put("refusal", saves.getRefusalDetail());
        }
        return positionSave;
    }

    private boolean showsOnlyTheLoad(Player exoPlayer) {
        Long startPositionMilliseconds = unreportedLoadPosition;
        return (
            startPositionMilliseconds != null &&
            !isPlayingForListener(exoPlayer) &&
            exoPlayer.getPlayerError() == null &&
            exoPlayer.getCurrentPosition() == startPositionMilliseconds
        );
    }

    private void endUnreportedLoad() {
        unreportedLoadPosition = null;
    }

    private boolean isPlayingForListener(Player exoPlayer) {
        return (
            exoPlayer.getPlayWhenReady() &&
            exoPlayer.getPlaybackSuppressionReason() == Player.PLAYBACK_SUPPRESSION_REASON_NONE &&
            exoPlayer.getPlaybackState() != Player.STATE_ENDED &&
            !hasPlaybackError
        );
    }

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

    private static final class TrackLoadErrorPolicy extends DefaultLoadErrorHandlingPolicy {
        @Override
        public long getRetryDelayMsFor(@NonNull LoadErrorInfo loadErrorInfo) {
            return isUrlRejection(loadErrorInfo.exception) ? C.TIME_UNSET : super.getRetryDelayMsFor(loadErrorInfo);
        }
    }

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

    private final class StateReporter implements Player.Listener {
        @Override
        public void onEvents(@NonNull Player eventPlayer, @NonNull Player.Events events) {
            if (eventPlayer != player) {
                return;
            }
            if (eventPlayer.getPlayerError() == null) {
                hasPlaybackError = false;
            }
            if (eventPlayer.getPlaybackState() == Player.STATE_ENDED) {
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
                stopSoon(ClosedReason.TRACK_URL_EXPIRED);
                return;
            }
            followPlayback(isPlayingForListener(eventPlayer));
            if (!showsOnlyTheLoad(eventPlayer)) {
                endUnreportedLoad();
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
                stopSoon(ClosedReason.TRACK_URL_EXPIRED);
                return;
            }
            hasPlaybackError = true;
            exoPlayer.pause();
        }
    }
}
