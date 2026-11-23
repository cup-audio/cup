package audio.cup.app;

import androidx.media3.common.ForwardingSimpleBasePlayer;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import com.google.common.util.concurrent.ListenableFuture;

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
