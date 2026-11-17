package audio.cup.app;

/**
 * When a loaded audiobook's {@link SignedUrls}, its track and position URLs, stop authorizing
 * requests. Both come from the same audiobook response and expire together. Plain Java, so JVM unit
 * tests cover it.
 */
final class SignedUrlExpiry {
    /**
     * How long the server's signed URLs stay valid at least after it handed them out: they expire
     * two days after the start of the UTC day they were issued on.
     */
    static final long SERVER_MINIMUM_VALIDITY_MILLISECONDS = 24 * 60 * 60 * 1_000;

    private final long expiresAt;

    /**
     * @param issuedAt when the page received the audiobook response that carried the URLs, in epoch
     *     milliseconds by the device's clock
     */
    SignedUrlExpiry(long issuedAt, long lifetimeMilliseconds) {
        expiresAt = issuedAt + lifetimeMilliseconds;
    }

    boolean hasExpired(long now) {
        return now >= expiresAt;
    }

    /** When the URLs expire, in epoch milliseconds by the device's clock. */
    long expiresAt() {
        return expiresAt;
    }

    long millisecondsUntilExpiry(long now) {
        return Math.max(0, expiresAt - now);
    }

    /**
     * Whether the server refused the signed track URL itself, so only a newly signed one plays: the
     * media route answers an expired or invalid token with 401, and a valid one whose grant expired or
     * was revoked with 403.
     */
    static boolean isUrlRejection(int httpStatus) {
        return httpStatus == 401 || httpStatus == 403;
    }
}
