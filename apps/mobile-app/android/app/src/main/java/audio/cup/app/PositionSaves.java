package audio.cup.app;

import java.util.ArrayDeque;

/**
 * The listening-position saves of one loaded audiobook, by the web player's rules
 * ({@code PlaybackSession} in {@code playback-session.ts}): saves are written in order through the
 * signed position URL, and only the latest save that failed for a reason that can pass is saved
 * again, after the retry delay or when the connection may be back, unless a newer save comes first.
 * A {@code 403} or {@code 404} refuses the save for good. Plain Java, so JVM unit tests cover it.
 *
 * <p>Must be used on one thread, which also receives the write callbacks.
 */
final class PositionSaves {
    static final long SAVE_INTERVAL_MILLISECONDS = 5_000;
    /** How long after a failed save its position is saved again, unless a newer save comes first. */
    static final long SAVE_RETRY_DELAY_MILLISECONDS = 15_000;

    /** How the saves fare, which the page words for the listener. */
    enum Status {
        /** The last save succeeded, or none failed yet. */
        OK,
        /** Saves fail for a reason that can pass, such as a lost connection; the latest is retried. */
        FAILING,
        /** The server refused the last save for good, in the words of {@link #getRefusalDetail()}. */
        REFUSED,
    }

    /** What the saves need from the platform; the plugin uses Android's, the tests their own. */
    interface Services {
        /** The device's clock, in epoch milliseconds, which the page's clock shares. */
        long now();

        /** Writes `position` with a `PUT` to `positionUrl`, then calls `callback` on the saves' thread. */
        void write(String positionUrl, ListeningPosition position, WriteCallback callback);

        /** Calls `callback` once after the delay, on the saves' thread; the returned task cancels it. */
        Runnable setRetryTimer(Runnable callback, long delayMilliseconds);

        /** The status, the refusal or when the failures began changed, or another save failed. */
        void onSaveStateChanged();
    }

    interface WriteCallback {
        void onWritten(Outcome outcome);
    }

    /** How the position route answered a save, or that the request failed without an answer. */
    static final class Outcome {
        private final Status status;
        private final String refusalDetail;

        private Outcome(Status status, String refusalDetail) {
            this.status = status;
            this.refusalDetail = refusalDetail;
        }

        /**
         * @param refusalDetail the error message the server answered with, if any
         */
        static Outcome fromResponse(int httpStatus, String refusalDetail) {
            if (httpStatus >= 200 && httpStatus < 300) {
                return new Outcome(Status.OK, null);
            }
            // The audiobook is gone or no longer this account's, or the account is blocked. An expired
            // position URL (401) is retried: the page's next renewal replaces it.
            if (httpStatus == 403 || httpStatus == 404) {
                return new Outcome(Status.REFUSED, refusalDetail == null ? "The server refused the save." : refusalDetail);
            }
            return new Outcome(Status.FAILING, null);
        }

        /** The request failed without an answer, such as without a connection. */
        static Outcome notConnected() {
            return new Outcome(Status.FAILING, null);
        }
    }

    private static final class SaveRequest {
        final ListeningPosition position;
        final long saveNumber;

        SaveRequest(ListeningPosition position, long saveNumber) {
            this.position = position;
            this.saveNumber = saveNumber;
        }
    }

    private final ListeningPositions positions;
    private final Services services;
    private final ArrayDeque<SaveRequest> queue = new ArrayDeque<>();
    private String positionUrl;
    private boolean isWriting;
    private long lastSavedAt = Long.MIN_VALUE;
    /** Counts save requests, so only the latest one's failure arms a retry. */
    private long latestSaveNumber;
    /** Cancels the armed retry timer of the latest position, whose save failed. */
    private Runnable cancelRetryTimer;
    /** The position the armed retry saves, also when the connection may be back. */
    private ListeningPosition retryPosition;
    private Status status = Status.OK;
    private String refusalDetail;
    /** When the saves started failing for a reason that can pass; `null` after a successful one. */
    private Long failingSince;
    private boolean isClosed;

    PositionSaves(ListeningPositions positions, String positionUrl, Services services) {
        this.positions = positions;
        this.positionUrl = positionUrl;
        this.services = services;
    }

    /** Saves a position on the narration track now. */
    void save(long positionMilliseconds) {
        enqueueSave(positions.at(positionMilliseconds));
    }

    /** Saves during playback, at most every {@link #SAVE_INTERVAL_MILLISECONDS}. */
    void saveIfDue(long positionMilliseconds) {
        if (lastSavedAt != Long.MIN_VALUE && services.now() - lastSavedAt < SAVE_INTERVAL_MILLISECONDS) {
            return;
        }
        save(positionMilliseconds);
    }

    /** The page renewed the URLs; the next writes, retries included, use the new one. */
    void replacePositionUrl(String url) {
        positionUrl = url;
    }

    /** The connection may be back: the device has a network again, or Cup returned to the foreground. */
    void reconnected() {
        if (retryPosition != null) {
            retry();
        }
    }

    /** Stops retrying; the saves queued so far, such as a final save, are still written. */
    void close() {
        isClosed = true;
        disarmRetry();
    }

    Status getStatus() {
        return status;
    }

    /** The server's words for the refusal, while {@link #getStatus()} is {@link Status#REFUSED}. */
    String getRefusalDetail() {
        return refusalDetail;
    }

    /** When the saves started failing for a reason that can pass, or `null`. */
    Long getFailingSince() {
        return failingSince;
    }

    /** Whether the last save failed for a reason that can pass, so a final save may still succeed. */
    boolean isFailing() {
        return status == Status.FAILING;
    }

    private void enqueueSave(ListeningPosition position) {
        disarmRetry();
        latestSaveNumber += 1;
        lastSavedAt = services.now();
        queue.add(new SaveRequest(position, latestSaveNumber));
        writeNext();
    }

    private void retry() {
        ListeningPosition position = retryPosition;
        enqueueSave(position);
    }

    private void writeNext() {
        if (isWriting || queue.isEmpty()) {
            return;
        }
        SaveRequest request = queue.remove();
        isWriting = true;
        services.write(positionUrl, request.position, outcome -> {
            isWriting = false;
            handleOutcome(request, outcome);
            writeNext();
        });
    }

    private void handleOutcome(SaveRequest request, Outcome outcome) {
        if (outcome.status == Status.OK) {
            failingSince = null;
            setStatus(Status.OK, null);
            return;
        }
        if (outcome.status == Status.REFUSED) {
            // Saving again would be refused too.
            setStatus(Status.REFUSED, outcome.refusalDetail);
            return;
        }
        // A newer save is queued already and carries a later position; its outcome counts.
        if (request.saveNumber != latestSaveNumber) {
            return;
        }
        if (failingSince == null) {
            failingSince = services.now();
        }
        if (!setStatus(Status.FAILING, null) && !isClosed) {
            // The page words a failure once saves have failed for the retry delay, which it can only
            // tell from a report after each failed save.
            services.onSaveStateChanged();
        }
        armRetry(request.position);
    }

    /** Returns whether it reported a change. */
    private boolean setStatus(Status nextStatus, String nextRefusalDetail) {
        boolean isUnchanged = nextStatus == status && equalOrBothNull(nextRefusalDetail, refusalDetail);
        status = nextStatus;
        refusalDetail = nextRefusalDetail;
        if (isUnchanged || isClosed) {
            return false;
        }
        services.onSaveStateChanged();
        return true;
    }

    private void armRetry(ListeningPosition position) {
        if (isClosed) {
            return;
        }
        retryPosition = position;
        cancelRetryTimer = services.setRetryTimer(this::retry, SAVE_RETRY_DELAY_MILLISECONDS);
    }

    private void disarmRetry() {
        if (cancelRetryTimer != null) {
            cancelRetryTimer.run();
        }
        cancelRetryTimer = null;
        retryPosition = null;
    }

    private static boolean equalOrBothNull(String left, String right) {
        return left == null ? right == null : left.equals(right);
    }
}
