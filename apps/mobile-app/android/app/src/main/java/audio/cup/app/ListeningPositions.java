package audio.cup.app;

final class ListeningPositions {
    private final String[] unitIds;
    private final long[] startMilliseconds;

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

    ListeningPosition at(long positionMilliseconds) {
        int unitIndex = findUnitIndexAt(startMilliseconds, positionMilliseconds);
        return new ListeningPosition(unitIds[unitIndex], Math.max(0, positionMilliseconds - startMilliseconds[unitIndex]));
    }

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
