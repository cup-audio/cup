package audio.cup.app;

/**
 * How long the media session's URLs and its foreground grace last. Release builds keep these
 * values; debug builds shorten them for the mobile E2E suite from its launch arguments
 * ({@code DebugApplication}, debug source set), so its lifecycle cases finish in seconds.
 */
final class PlaybackTimings {
    /** How long a loaded audiobook's signed URLs stay valid after the page fetched them. */
    static long signedUrlLifetimeMilliseconds = TrackUrlExpiry.SERVER_MINIMUM_VALIDITY_MILLISECONDS;

    /**
     * How long the service stays in the foreground after a pause, Media3's grace: its default and
     * maximum of 10 minutes.
     */
    static long foregroundGraceMilliseconds = 10 * 60 * 1_000;

    private PlaybackTimings() {}
}
