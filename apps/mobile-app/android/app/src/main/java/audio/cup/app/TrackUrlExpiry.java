package audio.cup.app;

/**
 * When a loaded audiobook's signed track and position URLs stop authorizing requests. Both come from
 * the same audiobook response and expire together. Plain Java, so JVM unit tests cover it.
 */
final class TrackUrlExpiry {
    /**
     * How long the server's signed URLs stay valid at least after it handed them out: they expire
     * two days after the start of the UTC day they were issued on.
     */
    static final long SERVER_MINIMUM_VALIDITY_MILLISECONDS = 24 * 60 * 60 * 1_000;

    private final long expiresAt;

    /**
     * @param urlsIssuedAt when the page fetched the audiobook response that carried the URLs, in
     *     epoch milliseconds by the device's clock
     */
    TrackUrlExpiry(long urlsIssuedAt, long lifetimeMilliseconds) {
        expiresAt = urlsIssuedAt + lifetimeMilliseconds;
    }

    boolean hasExpired(long now) {
        return now >= expiresAt;
    }

    long millisecondsUntilExpiry(long now) {
        return Math.max(0, expiresAt - now);
    }

    /**
     * Whether the server refused the signed URL itself, so only a newly signed one plays: the media
     * route answers an expired or invalid token with 401.
     */
    static boolean isUrlRejection(int httpStatus) {
        return httpStatus == 401 || httpStatus == 403;
    }
}
