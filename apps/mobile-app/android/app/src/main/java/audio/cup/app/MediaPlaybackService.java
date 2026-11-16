package audio.cup.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.CommandButton;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.ListenableFuture;

/**
 * The {@code mediaPlayback} foreground service that holds Cup's media session while the listener
 * listens, which keeps Cup unfrozen and its network reachable with the screen locked or in another
 * app. Its player only mirrors the WebView's {@code <audio>}; see {@link MirroringPlayer}.
 *
 * <p>The plugin starts it on the first {@code playing} of a loaded audiobook, always after a tap in
 * Cup's visible UI. Media3 then runs it in the foreground while the mirror plays, and for its
 * 10-minute grace after a pause or the end, after which it leaves the foreground and keeps the
 * notification.
 */
@UnstableApi
public class MediaPlaybackService extends MediaSessionService {
    private static final String TAG = "CupMediaSession";
    /** How long a Play from outside Cup waits for the foreground before it goes to the page anyway. */
    private static final long FOREGROUND_WAIT_MILLISECONDS = 2_000;

    /** The plugin's player, handed over before the plugin starts the service. */
    @Nullable
    private static MirroringPlayer sharedPlayer;

    @Nullable
    private static MediaPlaybackService running;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Nullable
    private MediaSession session;

    @Nullable
    private Runnable pendingPlay;

    /** Starts the service for `player`, unless it runs already. Must run on the main thread. */
    static void start(Context context, MirroringPlayer player) {
        if (running != null) {
            return;
        }
        sharedPlayer = player;
        try {
            context.startService(new Intent(context, MediaPlaybackService.class));
        } catch (IllegalStateException error) {
            // Android refuses to start services from the background; Cup starts it from a tap.
            Log.e(TAG, "The media session service could not be started.", error);
        }
    }

    /**
     * Runs `play`, which sends Play to the page, once the service is in the foreground. After the
     * grace, Android 15 and later refuse WebView's audio focus request, and with it Chromium's
     * {@code play()}, unless the service is back in the foreground first. Media3 returns it to the
     * foreground when the mirror shows the Play, so this waits for its next notification update.
     * Must run on the main thread.
     */
    static void whenInForeground(Runnable play) {
        MediaPlaybackService service = running;
        if (service == null || service.isInForeground()) {
            play.run();
            return;
        }
        service.holdPlay(play);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        MirroringPlayer player = sharedPlayer;
        if (player == null) {
            // Restarted by the system after Cup's process died: there is no page to mirror.
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
    public ListenableFuture<Void> onUpdateNotificationAsync(MediaSession session, boolean startInForegroundRequired) {
        ListenableFuture<Void> update = super.onUpdateNotificationAsync(session, startInForegroundRequired);
        update.addListener(
            () -> {
                if (isInForeground()) {
                    releasePlay();
                }
            },
            ContextCompat.getMainExecutor(this)
        );
        return update;
    }

    @Override
    public void onDestroy() {
        if (running == this) {
            running = null;
        }
        releasePlay();
        if (session != null) {
            session.release();
            session = null;
        }
        super.onDestroy();
    }

    private void holdPlay(Runnable play) {
        pendingPlay = play;
        mainHandler.postDelayed(this::releasePlay, FOREGROUND_WAIT_MILLISECONDS);
    }

    private void releasePlay() {
        mainHandler.removeCallbacksAndMessages(null);
        Runnable play = pendingPlay;
        pendingPlay = null;
        if (play != null) {
            play.run();
        }
    }

    private boolean isInForeground() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return getForegroundServiceType() != ServiceInfo.FOREGROUND_SERVICE_TYPE_NONE;
        }
        // Before Android 10 the service cannot tell, and the ordering does not matter there.
        return true;
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
