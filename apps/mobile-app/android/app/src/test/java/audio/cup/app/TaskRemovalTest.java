package audio.cup.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.media3.common.Player;
import org.junit.Test;

public class TaskRemovalTest {
    @Test
    public void aPlayingSessionIsKept() {
        assertTrue(TaskRemoval.keepsSession(true, Player.STATE_READY));
    }

    @Test
    public void aBufferingSessionIsKept() {
        assertTrue(TaskRemoval.keepsSession(true, Player.STATE_BUFFERING));
    }

    @Test
    public void aSessionPausedForATransientFocusLossIsKept() {
        assertTrue(TaskRemoval.keepsSession(true, Player.STATE_READY));
    }

    @Test
    public void aSessionTheListenerPausedEnds() {
        assertFalse(TaskRemoval.keepsSession(false, Player.STATE_READY));
        assertFalse(TaskRemoval.keepsSession(false, Player.STATE_BUFFERING));
    }

    @Test
    public void anEndedOrFailedSessionEnds() {
        assertFalse(TaskRemoval.keepsSession(true, Player.STATE_ENDED));
        assertFalse(TaskRemoval.keepsSession(true, Player.STATE_IDLE));
        assertFalse(TaskRemoval.keepsSession(false, Player.STATE_IDLE));
    }
}
