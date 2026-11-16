package audio.cup.app;

import androidx.media3.common.ForwardingSimpleBasePlayer;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import com.google.common.util.concurrent.ListenableFuture;

/**
 * The ExoPlayer as Cup's media session offers it to the system. There is no queue, so it offers no
 * previous and next, and the notification's back 15 and forward 15 buttons take their slots. It
 * keeps stop, or Media3 drops it from car head units, Android Auto and Wear OS, but handles it as
 * pause, so the audiobook stays loaded and the service keeps running.
 */
@UnstableApi
final class SessionPlayer extends ForwardingSimpleBasePlayer {
    SessionPlayer(Player player) {
        super(player);
    }

    @Override
    protected State getState() {
        State state = super.getState();
        return state
            .buildUpon()
            .setAvailableCommands(
                state.availableCommands
                    .buildUpon()
                    .removeAll(
                        Player.COMMAND_SEEK_TO_PREVIOUS,
                        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                        Player.COMMAND_SEEK_TO_NEXT,
                        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM
                    )
                    .build()
            )
            .build();
    }

    @Override
    protected ListenableFuture<?> handleStop() {
        return handleSetPlayWhenReady(false);
    }
}
