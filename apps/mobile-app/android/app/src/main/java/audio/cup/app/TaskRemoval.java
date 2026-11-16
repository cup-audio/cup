package audio.cup.app;

import androidx.media3.common.Player;

/** What swiping Cup from recents does with the session. Plain Java, so JVM unit tests cover it. */
final class TaskRemoval {
    private TaskRemoval() {}

    /**
     * Whether the session plays on after the swipe: ExoPlayer wants to play, also while it buffers or
     * a transient loss of audio focus, such as a call, suppresses it. A session the listener paused,
     * that ended or whose load failed, which pauses it, ends.
     */
    static boolean keepsSession(boolean playWhenReady, int playbackState) {
        return playWhenReady && playbackState != Player.STATE_IDLE && playbackState != Player.STATE_ENDED;
    }
}
