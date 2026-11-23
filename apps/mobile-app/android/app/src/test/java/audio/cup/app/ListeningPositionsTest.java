package audio.cup.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class ListeningPositionsTest {
    private static final ListeningPositions POSITIONS = new ListeningPositions(
        new String[] { "unit-1", "unit-2", "unit-3", "unit-4" },
        new long[] { 0, 20_000, 30_000, 33_000 }
    );

    @Test
    public void theCurrentUnitIsTheLastOneStartingAtOrBeforeAPosition() {
        long[] starts = { 0, 20_000, 30_000 };

        assertEquals(0, ListeningPositions.findUnitIndexAt(starts, 0));
        assertEquals(0, ListeningPositions.findUnitIndexAt(starts, 19_999));
        assertEquals(1, ListeningPositions.findUnitIndexAt(starts, 20_000));
        assertEquals(1, ListeningPositions.findUnitIndexAt(starts, 29_999));
        assertEquals(2, ListeningPositions.findUnitIndexAt(starts, 30_000));
        assertEquals(2, ListeningPositions.findUnitIndexAt(starts, 99_000));
        assertEquals(0, ListeningPositions.findUnitIndexAt(starts, -5));
    }

    @Test
    public void aPositionOnTheNarrationTrackBecomesTheUnitAndTheOffsetWithinItsAudio() {
        assertEquals(new ListeningPosition("unit-2", 7_500), POSITIONS.at(27_500));
        assertEquals(new ListeningPosition("unit-1", 0), POSITIONS.at(0));
        assertEquals(new ListeningPosition("unit-4", 1_000), POSITIONS.at(34_000));
    }

    @Test
    public void aPositionBeforeTheFirstStartIsTheStartOfTheFirstUnit() {
        ListeningPositions positions = new ListeningPositions(new String[] { "unit-1", "unit-2" }, new long[] { 500, 1_000 });

        assertEquals(new ListeningPosition("unit-1", 0), positions.at(200));
    }

    @Test
    public void aTimelineWhoseStartsDoNotMatchTheUnitsIsRefused() {
        IllegalArgumentException error = assertThrows(
            IllegalArgumentException.class,
            () -> new ListeningPositions(new String[] { "unit-1", "unit-2", "unit-3", "unit-4" }, new long[] { 0, 20_000 })
        );

        assertEquals("The timeline has 2 start offsets for 4 synchronization units.", error.getMessage());
    }

    @Test
    public void aTimelineWithoutUnitsIsRefused() {
        assertThrows(IllegalArgumentException.class, () -> new ListeningPositions(new String[0], new long[0]));
    }
}
