package audio.cup.app;

/**
 * Converts positions on a loaded audiobook's narration track into listening positions, as the web
 * player's {@code listeningPositionAt} and {@code findUnitIndexAt} do ({@code playback-session.ts},
 * {@code audiobook-timeline.ts}). Plain Java, so JVM unit tests cover it.
 */
final class ListeningPositions {
    private final String[] unitIds;
    private final long[] startMilliseconds;

    /**
     * @param unitIds the synchronization units' ids, in document order
     * @param startMilliseconds where each unit's audio starts on the narration track, in the same order
     * @throws IllegalArgumentException for a timeline without units or with a start per unit missing
     */
    ListeningPositions(String[] unitIds, long[] startMilliseconds) {
        if (unitIds.length != startMilliseconds.length) {
            throw new IllegalArgumentException(
                "The timeline has " + startMilliseconds.length + " start offsets for " + unitIds.length + " synchronization units."
            );
        }
        if (unitIds.length == 0) {
            throw new IllegalArgumentException("The timeline has no synchronization units.");
        }
        this.unitIds = unitIds.clone();
        this.startMilliseconds = startMilliseconds.clone();
    }

    /** The listening position at a position on the narration track. */
    ListeningPosition at(long positionMilliseconds) {
        int unitIndex = findUnitIndexAt(startMilliseconds, positionMilliseconds);
        return new ListeningPosition(unitIds[unitIndex], Math.max(0, positionMilliseconds - startMilliseconds[unitIndex]));
    }

    /**
     * The unit playing at a position: the last one that starts at or before it, or the first unit for
     * a position before every start.
     */
    static int findUnitIndexAt(long[] startMilliseconds, long positionMilliseconds) {
        int low = 0;
        int high = startMilliseconds.length - 1;
        while (low < high) {
            int middle = (low + high + 1) / 2;
            if (startMilliseconds[middle] <= positionMilliseconds) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        return low;
    }
}
