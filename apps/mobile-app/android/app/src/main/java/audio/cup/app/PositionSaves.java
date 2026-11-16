package audio.cup.app;

import java.util.ArrayDeque;

/**
 * The listening-position saves of one loaded audiobook, by the web player's rules
 * ({@code PlaybackSession} in {@code playback-session.ts}): saves are written in order through the
 * signed position URL, and only the latest save that failed for a reason that can pass is saved
 * again, after the retry delay or when the connection may be back, unless a newer save comes first.
 * Every {@code 4xx} answer but {@code 401} and {@code 429} refuses the save for good. Plain Java, so
 * JVM unit tests cover it.
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
        /**
         * Saves still fail for a reason that can pass: a retry failed too, or saves have failed for
         * {@link #SAVE_RETRY_DELAY_MILLISECONDS}. The page then tells the listener, as the web player
         * does; it stays until a save succeeds or is refused.
         */
        STILL_FAILING,
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

        /** The status or the refusal changed. */
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
            // A lasting refusal, as the web player reads every client error but too many requests,
            // such as an audiobook that is gone or no longer this account's. An expired position URL
            // (401) is retried instead: the page's next renewal replaces it.
            if (httpStatus >= 400 && httpStatus < 500 && httpStatus != 401 && httpStatus != 429) {
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
        /** Whether this retries a failed save, rather than saving what the listener's playback asked for. */
        final boolean isRetry;
        final long saveNumber;

        SaveRequest(ListeningPosition position, boolean isRetry, long saveNumber) {
            this.position = position;
            this.isRetry = isRetry;
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
        enqueueSave(positions.at(positionMilliseconds), false);
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

    /** Whether saves fail for a reason that can pass, so a final save may still succeed. */
    boolean isFailing() {
        return status == Status.FAILING || status == Status.STILL_FAILING;
    }

    private void enqueueSave(ListeningPosition position, boolean isRetry) {
        disarmRetry();
        latestSaveNumber += 1;
        lastSavedAt = services.now();
        queue.add(new SaveRequest(position, isRetry, latestSaveNumber));
        writeNext();
    }

    private void retry() {
        enqueueSave(retryPosition, true);
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
        // During playback, newer saves replace the retry every few seconds; they stay quiet until
        // saves have failed for as long as the retry delay.
        boolean hasFailedForRetryDelay = services.now() - failingSince >= SAVE_RETRY_DELAY_MILLISECONDS;
        if (request.isRetry || hasFailedForRetryDelay) {
            setStatus(Status.STILL_FAILING, null);
        } else if (status == Status.OK) {
            // A refusal, or a failure the page tells, stays until a save succeeds, as on the web.
            setStatus(Status.FAILING, null);
        }
        armRetry(request.position);
    }

    private void setStatus(Status nextStatus, String nextRefusalDetail) {
        boolean isUnchanged = nextStatus == status && equalOrBothNull(nextRefusalDetail, refusalDetail);
        status = nextStatus;
        refusalDetail = nextRefusalDetail;
        if (isUnchanged || isClosed) {
            return;
        }
        services.onSaveStateChanged();
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
