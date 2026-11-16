package audio.cup.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaNotification;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import com.google.common.collect.ImmutableList;

/**
 * The {@code mediaPlayback} foreground service that holds Cup's media session around the
 * {@link PlaybackEngine}'s ExoPlayer, which keeps Cup unfrozen and its network reachable with the
 * screen locked or in another app. The notification, the lock screen, media keys, headsets and
 * earbuds act on the player through the session, without the page.
 *
 * <p>The engine starts it on the first Play, always after a tap in Cup's visible UI. Media3 then
 * runs it in the foreground while the player plays, and for its grace after a pause or the end,
 * after which it leaves the foreground and keeps the notification. Swiping Cup from recents keeps a
 * playing session and ends a paused one ({@link TaskRemoval}); swiping the notification away, possible
 * only after the grace, ends it too. The service releases the player when it stops.
 */
@UnstableApi
public class MediaPlaybackService extends MediaSessionService {
    private static final String TAG = "CupMediaPlayback";

    /** The engine's player, handed over before the engine starts the service. */
    @Nullable
    private static Player sharedPlayer;

    @Nullable
    private static MediaPlaybackService running;

    @Nullable
    private MediaSession session;

    /** Starts the service for `player`, unless it runs already. Must run on the main thread. */
    static void start(Context context, Player player) {
        if (running != null || sharedPlayer == player) {
            return;
        }
        sharedPlayer = player;
        try {
            context.startService(new Intent(context, MediaPlaybackService.class));
        } catch (IllegalStateException error) {
            // Android refuses to start services from the background; Cup starts it from a tap.
            Log.e(TAG, "The media playback service could not be started.", error);
        }
    }

    /**
     * Stops the service, which removes its notification and releases the player. Returns whether
     * the service took `player` over; if not, the caller releases it. Must run on the main thread.
     */
    static boolean stop(Player player) {
        if (sharedPlayer != player) {
            return false;
        }
        sharedPlayer = null;
        MediaPlaybackService service = running;
        if (service == null) {
            // Started, but not created yet: its onCreate finds no player and stops.
            return false;
        }
        // Destroying the service is asynchronous; a Play before then starts a new one for its player.
        running = null;
        service.pauseAllPlayersAndStopSelf();
        return true;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Player player = sharedPlayer;
        if (player == null) {
            // Restarted by the system after Cup's process died, or closed before it was created.
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

    /**
     * Media3's default keeps a session in the foreground and stops the service otherwise; its grace
     * keeps a paused one in the foreground too. A playing session plays on, also while it buffers or a
     * call pauses it, and every other one ends.
     */
    @Override
    public void onTaskRemoved(@Nullable Intent rootIntent) {
        Player player = session == null ? null : session.getPlayer();
        if (
            !isPlaybackOngoing() ||
            player == null ||
            !TaskRemoval.keepsSession(player.getPlayWhenReady(), player.getPlaybackState())
        ) {
            PlaybackEngine.get(this).stopNatively(PlaybackEngine.ClosedReason.TASK_REMOVED);
        }
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

    /** Back 15 s, play/pause and forward 15 s; Media3 adds play/pause, and there is no stop button. */
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
                .build()
        );
    }

    private final class SessionCallback implements MediaSession.Callback {
        /**
         * Swiping the notification away arrives as stop, which the session player handles as pause;
         * the notification would then come back. It ends the session instead.
         */
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
