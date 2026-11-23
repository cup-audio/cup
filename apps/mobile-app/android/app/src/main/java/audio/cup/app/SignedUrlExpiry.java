package audio.cup.app;

final class SignedUrlExpiry {
    static final long SERVER_MINIMUM_VALIDITY_MILLISECONDS = 24 * 60 * 60 * 1_000;

    private final long expiresAt;

    SignedUrlExpiry(long issuedAt, long lifetimeMilliseconds) {
        expiresAt = issuedAt + lifetimeMilliseconds;
    }

    boolean hasExpired(long now) {
        return now >= expiresAt;
    }

    long expiresAt() {
        return expiresAt;
    }

    long millisecondsUntilExpiry(long now) {
        return Math.max(0, expiresAt - now);
    }

    static boolean isUrlRejection(int httpStatus) {
        return httpStatus == 401 || httpStatus == 403;
    }
}
