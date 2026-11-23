package audio.cup.app;

final class PlaybackTimings {
    static long signedUrlLifetimeMilliseconds = SignedUrlExpiry.SERVER_MINIMUM_VALIDITY_MILLISECONDS;

    static long foregroundGraceMilliseconds = 10 * 60 * 1_000;

    private PlaybackTimings() {}
}
