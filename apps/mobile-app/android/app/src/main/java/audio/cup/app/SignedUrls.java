package audio.cup.app;

/**
 * The signed track and position URLs of one audiobook response, which expire together;
 * {@code NativeUrls} on the page.
 */
final class SignedUrls {
    final String trackUrl;
    /** Authorizes the listening-position saves without the listener's session. */
    final String positionUrl;
    /**
     * When the page received the response that carried them, in epoch milliseconds by the device's
     * clock; the plugin's {@code urlsIssuedAt}.
     */
    final long issuedAt;

    SignedUrls(String trackUrl, String positionUrl, long issuedAt) {
        this.trackUrl = trackUrl;
        this.positionUrl = positionUrl;
        this.issuedAt = issuedAt;
    }

    SignedUrlExpiry expiry() {
        return new SignedUrlExpiry(issuedAt, PlaybackTimings.signedUrlLifetimeMilliseconds);
    }
}
