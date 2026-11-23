package audio.cup.app;

final class EndedSession {
    final String conversionId;
    private final PositionSaves saves;
    private final SignedUrlExpiry expiry;
    private final long positionMilliseconds;

    EndedSession(String conversionId, PositionSaves saves, SignedUrlExpiry expiry, long positionMilliseconds) {
        this.conversionId = conversionId;
        this.saves = saves;
        this.expiry = expiry;
        this.positionMilliseconds = positionMilliseconds;
        saves.close();
    }

    void saveIfUnsaved(long now) {
        if (saves.isFailing() && !expiry.hasExpired(now)) {
            saves.save(positionMilliseconds);
        }
    }
}
