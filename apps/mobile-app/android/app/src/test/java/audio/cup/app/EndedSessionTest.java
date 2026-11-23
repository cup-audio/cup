package audio.cup.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.util.List;
import org.junit.Test;

public class EndedSessionTest {
    private static final String POSITION_URL = "https://cup.example/api/audiobooks/conversion/position?token=first";
    private static final ListeningPositions POSITIONS = new ListeningPositions(
        new String[] { "unit-1", "unit-2" },
        new long[] { 0, 20_000 }
    );
    private static final long LIFETIME_MILLISECONDS = 60_000;

    private static final PositionSaves.Outcome SAVED = PositionSaves.Outcome.fromResponse(204, null);
    private static final PositionSaves.Outcome NOT_CONNECTED = PositionSaves.Outcome.notConnected();
    private static final PositionSaves.Outcome GONE = PositionSaves.Outcome.fromResponse(404, "The audiobook is gone.");

    @Test
    public void afterFailedSavesTheNativeStopSavesTheLastPositionOnce() {
        FakeSaveServices services = new FakeSaveServices();
        PositionSaves saves = failingSaves(services);

        EndedSession ended = endAt(saves, services, 22_000);
        ended.saveIfUnsaved(services.now);

        assertEquals(List.of(POSITION_URL + " unit-1+1000", POSITION_URL + " unit-2+2000"), services.sent);
    }

    @Test
    public void whenTheNativeStopsSaveFailsTooALaterSaveTriesAgainWithoutRetryingMeanwhile() {
        FakeSaveServices services = new FakeSaveServices();
        PositionSaves saves = failingSaves(services);
        EndedSession ended = endAt(saves, services, 22_000);
        ended.saveIfUnsaved(services.now);
        services.answer(NOT_CONNECTED);
        assertNull(services.retryTimer);

        ended.saveIfUnsaved(services.now);
        services.answer(SAVED);
        ended.saveIfUnsaved(services.now);

        assertEquals(
            List.of(POSITION_URL + " unit-1+1000", POSITION_URL + " unit-2+2000", POSITION_URL + " unit-2+2000"),
            services.sent
        );
    }

    @Test
    public void afterASuccessfulLastSaveNothingIsSaved() {
        FakeSaveServices services = new FakeSaveServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);
        saves.save(1_000);
        services.answer(SAVED);

        EndedSession ended = endAt(saves, services, 22_000);
        ended.saveIfUnsaved(services.now);

        assertEquals(List.of(POSITION_URL + " unit-1+1000"), services.sent);
    }

    @Test
    public void afterARefusalNothingIsSaved() {
        FakeSaveServices services = new FakeSaveServices();
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);
        saves.save(1_000);
        services.answer(GONE);

        EndedSession ended = endAt(saves, services, 22_000);
        ended.saveIfUnsaved(services.now);

        assertEquals(List.of(POSITION_URL + " unit-1+1000"), services.sent);
    }

    @Test
    public void onceTheUrlsExpiredNothingIsSaved() {
        FakeSaveServices services = new FakeSaveServices();
        PositionSaves saves = failingSaves(services);

        EndedSession ended = endAt(saves, services, 22_000);
        ended.saveIfUnsaved(services.now + LIFETIME_MILLISECONDS);

        assertEquals(List.of(POSITION_URL + " unit-1+1000"), services.sent);
    }

    private static PositionSaves failingSaves(FakeSaveServices services) {
        PositionSaves saves = new PositionSaves(POSITIONS, POSITION_URL, services);
        saves.save(1_000);
        services.answer(NOT_CONNECTED);
        return saves;
    }

    private static EndedSession endAt(PositionSaves saves, FakeSaveServices services, long positionMilliseconds) {
        return new EndedSession(
            "conversion",
            saves,
            new SignedUrlExpiry(services.now, LIFETIME_MILLISECONDS),
            positionMilliseconds
        );
    }
}
