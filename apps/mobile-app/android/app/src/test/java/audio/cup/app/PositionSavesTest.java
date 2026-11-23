package audio.cup.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.List;
import org.junit.Test;

public class PositionSavesTest {
    private static final String POSITION_URL = "https://cup.example/api/audiobooks/conversion/position?token=first";
    private static final String RENEWED_POSITION_URL = "https://cup.example/api/audiobooks/conversion/position?token=renewed";

    private static final ListeningPositions POSITIONS = new ListeningPositions(
        new String[] { "unit-1", "unit-2", "unit-3", "unit-4" },
        new long[] { 0, 20_000, 30_000, 33_000 }
    );

    private static final PositionSaves.Outcome SAVED = PositionSaves.Outcome.fromResponse(204, null);
    private static final PositionSaves.Outcome NOT_CONNECTED = PositionSaves.Outcome.notConnected();

    @Test
    public void savesAreWrittenInOrderThroughThePositionUrlAsListeningPositions() {
        FakeSaveServices services = new FakeSaveServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        saves.save(21_000);
        assertEquals(1, services.pending.size());
        services.answerAll(SAVED);

        assertEquals(List.of(POSITION_URL + " unit-1+1000", POSITION_URL + " unit-2+1000"), services.sent);
        assertEquals(PositionSaves.Status.OK, saves.getStatus());
    }

    @Test
    public void savesDuringPlaybackWaitForTheSaveInterval() {
        FakeSaveServices services = new FakeSaveServices();
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
        FakeSaveServices services = new FakeSaveServices();
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
        FakeSaveServices services = new FakeSaveServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(NOT_CONNECTED);
        saves.reconnected();
        services.answer(SAVED);

        assertEquals(2, services.sent.size());
        assertNull(services.retryTimer);
        saves.reconnected();
        assertEquals(2, services.sent.size());
    }

    @Test
    public void aNewerSaveReplacesTheRetryOfAFailedOne() {
        FakeSaveServices services = new FakeSaveServices();
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
        FakeSaveServices services = new FakeSaveServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        saves.save(21_000);
        services.answer(NOT_CONNECTED);
        assertNull(services.retryTimer);
        services.answer(NOT_CONNECTED);

        services.fireRetryTimer();
        services.answer(SAVED);
        assertEquals(POSITION_URL + " unit-2+1000", services.sent.get(services.sent.size() - 1));
    }

    @Test
    public void aFailedRetryReportsThatSavesStillFailUntilASaveSucceeds() {
        FakeSaveServices services = new FakeSaveServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(NOT_CONNECTED);
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
        FakeSaveServices services = new FakeSaveServices();
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
        FakeSaveServices services = new FakeSaveServices();
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
        FakeSaveServices services = new FakeSaveServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(NOT_CONNECTED);
        saves.reconnected();
        services.answer(NOT_CONNECTED);
        saves.save(2_000);
        services.answer(NOT_CONNECTED);

        assertEquals(PositionSaves.Status.STILL_FAILING, saves.getStatus());
    }

    @Test
    public void theStateIsReportedOnlyWhenTheStatusChanges() {
        FakeSaveServices services = new FakeSaveServices();
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
            FakeSaveServices services = new FakeSaveServices();
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
        FakeSaveServices services = new FakeSaveServices();
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
            FakeSaveServices services = new FakeSaveServices();
            PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

            saves.save(1_000);
            services.answer(PositionSaves.Outcome.fromResponse(status, "Try again."));

            assertEquals(PositionSaves.Status.FAILING, saves.getStatus());
            assertEquals(PositionSaves.SAVE_RETRY_DELAY_MILLISECONDS, services.retryDelay);
        }
    }

    @Test
    public void savesAndRetriesUseTheLatestPositionUrl() {
        FakeSaveServices services = new FakeSaveServices();
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
        FakeSaveServices services = new FakeSaveServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);

        saves.save(1_000);
        services.answer(NOT_CONNECTED);
        saves.save(21_000);
        saves.close();
        services.answer(NOT_CONNECTED);

        assertNull(services.retryTimer);
        saves.reconnected();
        assertEquals(List.of(POSITION_URL + " unit-1+1000", POSITION_URL + " unit-2+1000"), services.sent);
    }

    @Test
    public void eachStatusCarriesThePagesNameForIt() {
        assertEquals("ok", PositionSaves.Status.OK.wireName);
        assertEquals("failing", PositionSaves.Status.FAILING.wireName);
        assertEquals("stillFailing", PositionSaves.Status.STILL_FAILING.wireName);
        assertEquals("refused", PositionSaves.Status.REFUSED.wireName);
    }
}
