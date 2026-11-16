package audio.cup.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/** Mirrors the web player's save rules in `playback-session.test.ts`. */
public class PositionSavesTest {
    private static final String POSITION_URL = "https://cup.example/api/audiobooks/conversion/position?token=first";
    private static final String RENEWED_POSITION_URL = "https://cup.example/api/audiobooks/conversion/position?token=renewed";

    // Units of 20, 10, 3 and 2 seconds on the narration track.
    private static final ListeningPositions POSITIONS = new ListeningPositions(
        new String[] { "unit-1", "unit-2", "unit-3", "unit-4" },
        new long[] { 0, 20_000, 30_000, 33_000 }
    );

    /** The services, which the tests drive in place of the network, the clock and the timer. */
    private static final class FakeServices implements PositionSaves.Services {
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
    }

    private static final class Write {
        final ListeningPosition position;
        final PositionSaves.WriteCallback callback;

        Write(ListeningPosition position, PositionSaves.WriteCallback callback) {
            this.position = position;
            this.callback = callback;
        }
    }

    private static final PositionSaves.Outcome SAVED = PositionSaves.Outcome.fromResponse(204, null);
    private static final PositionSaves.Outcome NOT_CONNECTED = PositionSaves.Outcome.notConnected();

    @Test
    public void savesAreWrittenInOrderThroughThePositionUrlAsListeningPositions() {
        FakeServices services = new FakeServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        saves.save(21_000);
        // The second save waits until the first one was written.
        assertEquals(1, services.pending.size());
        services.answerAll(SAVED);

        assertEquals(List.of(POSITION_URL + " unit-1+1000", POSITION_URL + " unit-2+1000"), services.sent);
        assertEquals(PositionSaves.Status.OK, saves.getStatus());
    }

    @Test
    public void savesDuringPlaybackWaitForTheSaveInterval() {
        FakeServices services = new FakeServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.saveIfDue(1_000);
        services.now += PositionSaves.SAVE_INTERVAL_MILLISECONDS - 1;
        saves.saveIfDue(2_000);
        services.answerAll(SAVED);
        assertEquals(1, services.sent.size());

        services.now += 1;
        saves.saveIfDue(3_000);
        services.answerAll(SAVED);
        assertEquals(2, services.sent.size());
    }

    @Test
    public void aSaveThatFailsForALostConnectionIsRetriedAfterTheRetryDelay() {
        FakeServices services = new FakeServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(NOT_CONNECTED);
        assertEquals(PositionSaves.SAVE_RETRY_DELAY_MILLISECONDS, services.retryDelay);
        assertEquals(PositionSaves.Status.FAILING, saves.getStatus());

        services.fireRetryTimer();
        services.answer(SAVED);

        assertEquals(List.of(POSITION_URL + " unit-1+1000", POSITION_URL + " unit-1+1000"), services.sent);
        assertNull(services.retryTimer);
        assertEquals(PositionSaves.Status.OK, saves.getStatus());
    }

    @Test
    public void aFailedSaveIsRetriedWhenTheConnectionMayBeBack() {
        FakeServices services = new FakeServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(NOT_CONNECTED);
        saves.reconnected();
        services.answer(SAVED);

        assertEquals(2, services.sent.size());
        assertNull(services.retryTimer);
        // Without a failed save, a reconnect sends nothing.
        saves.reconnected();
        assertEquals(2, services.sent.size());
    }

    @Test
    public void aNewerSaveReplacesTheRetryOfAFailedOne() {
        FakeServices services = new FakeServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(NOT_CONNECTED);
        saves.save(21_000);
        services.answer(SAVED);

        assertEquals(List.of(POSITION_URL + " unit-1+1000", POSITION_URL + " unit-2+1000"), services.sent);
        assertNull(services.retryTimer);
        saves.reconnected();
        assertEquals(2, services.sent.size());
    }

    @Test
    public void onlyTheLatestSaveIsRetried() {
        FakeServices services = new FakeServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        saves.save(21_000);
        // The older save fails while the newer one waits; the newer one's outcome counts.
        services.answer(NOT_CONNECTED);
        assertNull(services.retryTimer);
        services.answer(NOT_CONNECTED);

        services.fireRetryTimer();
        services.answer(SAVED);
        assertEquals(POSITION_URL + " unit-2+1000", services.sent.get(services.sent.size() - 1));
    }

    @Test
    public void aFailedRetryReportsThatSavesStillFailUntilASaveSucceeds() {
        FakeServices services = new FakeServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(NOT_CONNECTED);
        // The page stays quiet about a first failure, as the web player does.
        assertEquals(PositionSaves.Status.FAILING, saves.getStatus());
        assertTrue(saves.isFailing());

        services.fireRetryTimer();
        services.answer(NOT_CONNECTED);
        assertEquals(PositionSaves.Status.STILL_FAILING, saves.getStatus());
        assertTrue(saves.isFailing());

        services.fireRetryTimer();
        services.answer(SAVED);
        assertEquals(PositionSaves.Status.OK, saves.getStatus());
        assertFalse(saves.isFailing());
    }

    @Test
    public void aRetryOnReconnectThatFailsReportsThatSavesStillFailBeforeTheRetryDelay() {
        FakeServices services = new FakeServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(NOT_CONNECTED);
        services.now += 1_000;
        saves.reconnected();
        services.answer(NOT_CONNECTED);

        assertEquals(PositionSaves.Status.STILL_FAILING, saves.getStatus());
    }

    @Test
    public void newSavesThatFailForTheRetryDelayReportThatSavesStillFail() {
        FakeServices services = new FakeServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(NOT_CONNECTED);
        services.now += PositionSaves.SAVE_RETRY_DELAY_MILLISECONDS - 1;
        saves.save(2_000);
        services.answer(NOT_CONNECTED);
        assertEquals(PositionSaves.Status.FAILING, saves.getStatus());

        services.now += 1;
        saves.save(3_000);
        services.answer(NOT_CONNECTED);
        assertEquals(PositionSaves.Status.STILL_FAILING, saves.getStatus());
    }

    @Test
    public void aNewSaveThatFailsKeepsReportingThatSavesStillFail() {
        FakeServices services = new FakeServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(NOT_CONNECTED);
        saves.reconnected();
        services.answer(NOT_CONNECTED);
        // Within the retry delay of the first failure, but saves still fail.
        saves.save(2_000);
        services.answer(NOT_CONNECTED);

        assertEquals(PositionSaves.Status.STILL_FAILING, saves.getStatus());
    }

    @Test
    public void theStateIsReportedOnlyWhenTheStatusChanges() {
        FakeServices services = new FakeServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(NOT_CONNECTED);
        assertEquals(1, services.stateChanges);
        saves.save(2_000);
        services.answer(NOT_CONNECTED);
        assertEquals(1, services.stateChanges);

        services.fireRetryTimer();
        services.answer(NOT_CONNECTED);
        assertEquals(2, services.stateChanges);

        services.fireRetryTimer();
        services.answer(SAVED);
        assertEquals(3, services.stateChanges);
        saves.save(3_000);
        services.answer(SAVED);
        assertEquals(3, services.stateChanges);
    }

    @Test
    public void everyClientErrorButAnExpiredUrlOrTooManyRequestsRefusesTheSaveInTheServersWordsWithoutRetrying() {
        for (int status : new int[] { 400, 403, 404, 409, 422 }) {
            FakeServices services = new FakeServices();
            PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

            saves.save(1_000);
            services.answer(PositionSaves.Outcome.fromResponse(status, "Audiobook not found."));

            assertEquals(PositionSaves.Status.REFUSED, saves.getStatus());
            assertEquals("Audiobook not found.", saves.getRefusalDetail());
            assertNull(services.retryTimer);
            saves.reconnected();
            assertEquals(1, services.sent.size());
        }
    }

    @Test
    public void aRefusedSaveDoesNotHoldBackTheNextOne() {
        FakeServices services = new FakeServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(PositionSaves.Outcome.fromResponse(404, "Audiobook not found."));
        saves.save(21_000);
        services.answer(SAVED);

        assertEquals(PositionSaves.Status.OK, saves.getStatus());
        assertNull(saves.getRefusalDetail());
    }

    @Test
    public void anExpiredUrlTooManyRequestsAndServerFailuresAreRetried() {
        for (int status : new int[] { 401, 429, 500, 503 }) {
            FakeServices services = new FakeServices();
            PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

            saves.save(1_000);
            services.answer(PositionSaves.Outcome.fromResponse(status, "Try again."));

            assertEquals(PositionSaves.Status.FAILING, saves.getStatus());
            assertEquals(PositionSaves.SAVE_RETRY_DELAY_MILLISECONDS, services.retryDelay);
        }
    }

    @Test
    public void savesAndRetriesUseTheLatestPositionUrl() {
        FakeServices services = new FakeServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(PositionSaves.Outcome.fromResponse(401, "The position URL is invalid or expired."));
        saves.replacePositionUrl(RENEWED_POSITION_URL);
        services.fireRetryTimer();
        services.answer(SAVED);

        assertEquals(RENEWED_POSITION_URL + " unit-1+1000", services.sent.get(1));
    }

    @Test
    public void closingStopsRetryingButWritesTheSavesQueuedBefore() {
        FakeServices services = new FakeServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(NOT_CONNECTED);
        // The final save of a closing session.
        saves.save(21_000);
        saves.close();
        services.answer(NOT_CONNECTED);

        assertNull(services.retryTimer);
        saves.reconnected();
        assertEquals(List.of(POSITION_URL + " unit-1+1000", POSITION_URL + " unit-2+1000"), services.sent);
    }
}
