package audio.cup.app;

/**
 * The saves of a session that ended without the page, kept so its last position is not lost while
 * the page lives: the native stop tries one final save, and if that fails too, the page's next close
 * with a save, or its load of another audiobook, tries once more. Nothing retries in between, and
 * nothing saves once the last save succeeded or was refused, or the URLs expired. Plain Java, so JVM
 * unit tests cover it.
 */
final class EndedSession {
    final String conversionId;
    private final PositionSaves saves;
    private final SignedUrlExpiry expiry;
    private final long positionMilliseconds;

    /** Stops `saves` retrying; the saves queued so far are still written. */
    EndedSession(String conversionId, PositionSaves saves, SignedUrlExpiry expiry, long positionMilliseconds) {
        this.conversionId = conversionId;
        this.saves = saves;
        this.expiry = expiry;
        this.positionMilliseconds = positionMilliseconds;
        saves.close();
    }

    /** Saves the last position, unless the last save succeeded or was refused, or the URLs expired. */
    void saveIfUnsaved(long now) {
        if (saves.isFailing() && !expiry.hasExpired(now)) {
            saves.save(positionMilliseconds);
        }
    }
}
