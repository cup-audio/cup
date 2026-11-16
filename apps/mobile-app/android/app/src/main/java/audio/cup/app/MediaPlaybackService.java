package audio.cup.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import com.google.common.collect.ImmutableList;

/**
 * The {@code mediaPlayback} foreground service that holds Cup's media session around the
 * {@link MediaPlaybackPlugin}'s ExoPlayer, which keeps Cup unfrozen and its network reachable with
 * the screen locked or in another app. The notification, the lock screen, media keys, headsets and
 * earbuds act on the player through the session, without the page.
 *
 * <p>The plugin starts it on the first Play, always after a tap in Cup's visible UI. Media3 then runs
 * it in the foreground while the player plays, and for its 10-minute grace after a pause or the end,
 * after which it leaves the foreground and keeps the notification. The service releases the player
 * when it stops.
 */
@UnstableApi
public class MediaPlaybackService extends MediaSessionService {
    private static final String TAG = "CupMediaPlayback";

    /** The plugin's player, handed over before the plugin starts the service. */
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
        Intent openCup = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        session = new MediaSession.Builder(this, player)
            .setSessionActivity(PendingIntent.getActivity(this, 0, openCup, PendingIntent.FLAG_IMMUTABLE))
            .setMediaButtonPreferences(notificationButtons())
            .build();
        addSession(session);
    }

    @Nullable
    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    @Override
    public void onDestroy() {
        if (running == this) {
            running = null;
        }
        if (session != null) {
            Player player = session.getPlayer();
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
}
