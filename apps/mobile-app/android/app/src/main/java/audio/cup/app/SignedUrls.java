package audio.cup.app;

final class SignedUrls {
    final String trackUrl;
    final String positionUrl;
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
