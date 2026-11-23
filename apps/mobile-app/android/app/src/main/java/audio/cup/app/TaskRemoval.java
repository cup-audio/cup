package audio.cup.app;

import androidx.media3.common.Player;

final class TaskRemoval {
    private TaskRemoval() {}

    static boolean keepsSession(boolean playWhenReady, int playbackState) {
        return playWhenReady && playbackState != Player.STATE_IDLE && playbackState != Player.STATE_ENDED;
    }
}
