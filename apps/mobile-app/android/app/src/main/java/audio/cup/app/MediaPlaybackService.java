package audio.cup.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaNotification;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionResult;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

@UnstableApi
public class MediaPlaybackService extends MediaSessionService {
    private static final String TAG = "CupMediaPlayback";

    private static final SessionCommand CLOSE = new SessionCommand("audio.cup.app.CLOSE", Bundle.EMPTY);

    @Nullable
    private static Player sharedPlayer;

    @Nullable
    private static MediaPlaybackService running;

    @Nullable
    private MediaSession session;

    static void start(Context context, Player player) {
        if (running != null || sharedPlayer == player) {
            return;
        }
        sharedPlayer = player;
        try {
            context.startService(new Intent(context, MediaPlaybackService.class));
        } catch (IllegalStateException error) {
            Log.e(TAG, "The media playback service could not be started.", error);
        }
    }

    static boolean stop(Player player) {
        if (sharedPlayer != player) {
            return false;
        }
        sharedPlayer = null;
        MediaPlaybackService service = running;
        if (service == null) {
            return false;
        }
        running = null;
        service.endSession();
        return true;
    }

    private void endSession() {
        if (session != null) {
            if (isSessionAdded(session)) {
                removeSession(session);
            }
            session.getPlayer().setPlayWhenReady(false);
        }
        stopSelf();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Player player = sharedPlayer;
        if (player == null) {
            stopSelf();
            return;
        }
        running = this;
        setForegroundServiceTimeoutMs(PlaybackTimings.foregroundGraceMilliseconds);
        Intent openCup = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        session = new MediaSession.Builder(this, player)
            .setSessionActivity(PendingIntent.getActivity(this, 0, openCup, PendingIntent.FLAG_IMMUTABLE))
            .setMediaButtonPreferences(notificationButtons())
            .setCallback(new SessionCallback())
            .build();
        addSession(session);
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        Player player = session == null ? null : session.getPlayer();
        if (player != null && TaskRemoval.keepsSession(player.getPlayWhenReady(), player.getPlaybackState())) {
            return;
        }
        PlaybackEngine.get(this).stopNatively(PlaybackEngine.ClosedReason.TASK_REMOVED);
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (running == this) {
            running = null;
        }
        if (session != null) {
            Player player = session.getPlayer();
            PlaybackEngine.get(this).onServiceDestroyed(player);
            session.release();
            player.release();
            session = null;
        }
        super.onDestroy();
    }

    private ImmutableList<CommandButton> notificationButtons() {
        return ImmutableList.of(
            new CommandButton.Builder(CommandButton.ICON_SKIP_BACK_15)
                .setDisplayName(getString(R.string.media_session_back))
                .setPlayerCommand(Player.COMMAND_SEEK_BACK)
                .setSlots(CommandButton.SLOT_BACK)
                .build(),
            new CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD_15)
                .setDisplayName(getString(R.string.media_session_forward))
                .setPlayerCommand(Player.COMMAND_SEEK_FORWARD)
                .setSlots(CommandButton.SLOT_FORWARD)
                .build(),
            new CommandButton.Builder(CommandButton.ICON_UNDEFINED)
                .setCustomIconResId(R.drawable.ic_media_close)
                .setDisplayName(getString(R.string.media_session_close))
                .setSessionCommand(CLOSE)
                .setSlots(CommandButton.SLOT_OVERFLOW)
                .build()
        );
    }

    private final class SessionCallback implements MediaSession.Callback {
        @NonNull
        @Override
        public MediaSession.ConnectionResult onConnect(
            @NonNull MediaSession mediaSession,
            @NonNull MediaSession.ControllerInfo controllerInfo
        ) {
            MediaSession.ConnectionResult result = MediaSession.Callback.super.onConnect(mediaSession, controllerInfo);
            if (!result.isAccepted) {
                return result;
            }
            return new MediaSession.ConnectionResult.AcceptedResultBuilder(mediaSession)
                .setAvailableSessionCommands(result.availableSessionCommands.buildUpon().add(CLOSE).build())
                .build();
        }

        @NonNull
        @Override
        public ListenableFuture<SessionResult> onCustomCommand(
            @NonNull MediaSession mediaSession,
            @NonNull MediaSession.ControllerInfo controllerInfo,
            @NonNull SessionCommand customCommand,
            @NonNull Bundle args
        ) {
            if (!customCommand.customAction.equals(CLOSE.customAction)) {
                return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED));
            }
            PlaybackEngine.get(MediaPlaybackService.this).stopNatively(PlaybackEngine.ClosedReason.CLOSED);
            return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_SUCCESS));
        }

        @Override
        public boolean onMediaButtonEvent(
            @NonNull MediaSession mediaSession,
            @NonNull MediaSession.ControllerInfo controllerInfo,
            @NonNull Intent intent
        ) {
            if (!intent.getBooleanExtra(MediaNotification.NOTIFICATION_DISMISSED_EVENT_KEY, false)) {
                return false;
            }
            PlaybackEngine.get(MediaPlaybackService.this).stopNatively(PlaybackEngine.ClosedReason.NOTIFICATION_DISMISSED);
            return true;
        }
    }
}
