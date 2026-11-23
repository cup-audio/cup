package audio.cup.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SignedUrlExpiryTest {
    private static final long HOUR_MILLISECONDS = 60 * 60 * 1_000;
    private static final long ISSUED_AT = 1_800_000_000_000L;

    @Test
    public void urlsStayValidForTheServersMinimumValidityOf24Hours() {
        SignedUrlExpiry expiry = new SignedUrlExpiry(ISSUED_AT, SignedUrlExpiry.SERVER_MINIMUM_VALIDITY_MILLISECONDS);

        assertFalse(expiry.hasExpired(ISSUED_AT));
        assertFalse(expiry.hasExpired(ISSUED_AT + 24 * HOUR_MILLISECONDS - 1));
        assertTrue(expiry.hasExpired(ISSUED_AT + 24 * HOUR_MILLISECONDS));
        assertTrue(expiry.hasExpired(ISSUED_AT + 30 * HOUR_MILLISECONDS));
    }

    @Test
    public void theTimeLeftCountsDownToTheExpiryAndStaysAtZeroAfterIt() {
        SignedUrlExpiry expiry = new SignedUrlExpiry(ISSUED_AT, 10_000);

        assertEquals(10_000, expiry.millisecondsUntilExpiry(ISSUED_AT));
        assertEquals(2_500, expiry.millisecondsUntilExpiry(ISSUED_AT + 7_500));
        assertEquals(0, expiry.millisecondsUntilExpiry(ISSUED_AT + 10_000));
        assertEquals(0, expiry.millisecondsUntilExpiry(ISSUED_AT + 60_000));
    }

    @Test
    public void aClockSetBackBeforeTheIssueLeavesTheUrlsValid() {
        SignedUrlExpiry expiry = new SignedUrlExpiry(ISSUED_AT, 10_000);

        assertFalse(expiry.hasExpired(ISSUED_AT - HOUR_MILLISECONDS));
        assertEquals(10_000 + HOUR_MILLISECONDS, expiry.millisecondsUntilExpiry(ISSUED_AT - HOUR_MILLISECONDS));
    }

    @Test
    public void theServerRejectingTheSignedUrlMeansItExpired() {
        assertTrue(SignedUrlExpiry.isUrlRejection(401));
        assertTrue(SignedUrlExpiry.isUrlRejection(403));
    }

    @Test
    public void otherFailuresOfTheTrackRequestAreNoRejectionOfTheUrl() {
        assertFalse(SignedUrlExpiry.isUrlRejection(404));
        assertFalse(SignedUrlExpiry.isUrlRejection(416));
        assertFalse(SignedUrlExpiry.isUrlRejection(500));
        assertFalse(SignedUrlExpiry.isUrlRejection(503));
    }
}
