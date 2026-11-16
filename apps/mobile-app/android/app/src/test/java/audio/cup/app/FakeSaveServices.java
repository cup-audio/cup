package audio.cup.app;

import java.util.ArrayList;
import java.util.List;

/** The saves' services, which the tests drive in place of the network, the clock and the timer. */
final class FakeSaveServices implements PositionSaves.Services {
    long now = 1_000_000;
    /** The writes sent and not answered yet, oldest first. */
    final List<Write> pending = new ArrayList<>();
    /** Every write sent, as `url position`. */
    final List<String> sent = new ArrayList<>();
    Runnable retryTimer;
    long retryDelay;
    int stateChanges;

    @Override
    public long now() {
        return now;
    }

    @Override
    public void write(String positionUrl, ListeningPosition position, PositionSaves.WriteCallback callback) {
        sent.add(positionUrl + " " + position);
        pending.add(new Write(position, callback));
    }

    @Override
    public Runnable setRetryTimer(Runnable callback, long delayMilliseconds) {
        retryTimer = callback;
        retryDelay = delayMilliseconds;
        return () -> {
            if (retryTimer == callback) {
                retryTimer = null;
            }
        };
    }

    @Override
    public void onSaveStateChanged() {
        stateChanges += 1;
    }

    /** Answers the oldest pending write. */
    void answer(PositionSaves.Outcome outcome) {
        pending.remove(0).callback.onWritten(outcome);
    }

    /** Answers every pending write, and those they let through, with `outcome`. */
    void answerAll(PositionSaves.Outcome outcome) {
        while (!pending.isEmpty()) {
            answer(outcome);
        }
    }

    void fireRetryTimer() {
        Runnable timer = retryTimer;
        retryTimer = null;
        timer.run();
    }

    static final class Write {
        final ListeningPosition position;
        final PositionSaves.WriteCallback callback;

        Write(ListeningPosition position, PositionSaves.WriteCallback callback) {
            this.position = position;
            this.callback = callback;
        }
    }
}
