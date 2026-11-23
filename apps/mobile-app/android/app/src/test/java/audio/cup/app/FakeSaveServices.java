package audio.cup.app;

import java.util.ArrayList;
import java.util.List;

final class FakeSaveServices implements PositionSaves.Services {
    long now = 1_000_000;
    final List<Write> pending = new ArrayList<>();
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

    void answer(PositionSaves.Outcome outcome) {
        pending.remove(0).callback.onWritten(outcome);
    }

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
