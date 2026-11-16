package audio.cup.app;

/** A synchronization unit and the offset within its audio, as the position route stores it. */
final class ListeningPosition {
    final String synchronizationUnitId;
    final long offsetMilliseconds;

    ListeningPosition(String synchronizationUnitId, long offsetMilliseconds) {
        this.synchronizationUnitId = synchronizationUnitId;
        this.offsetMilliseconds = offsetMilliseconds;
    }

    @Override
    public boolean equals(Object other) {
        if (!(other instanceof ListeningPosition)) {
            return false;
        }
        ListeningPosition position = (ListeningPosition) other;
        return synchronizationUnitId.equals(position.synchronizationUnitId) && offsetMilliseconds == position.offsetMilliseconds;
    }

    @Override
    public int hashCode() {
        return synchronizationUnitId.hashCode() * 31 + Long.hashCode(offsetMilliseconds);
    }

    @Override
    public String toString() {
        return synchronizationUnitId + "+" + offsetMilliseconds;
    }
}
