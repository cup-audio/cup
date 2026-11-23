package audio.cup.app;

import java.util.ArrayDeque;

final class PositionSaves {
    static final long SAVE_INTERVAL_MILLISECONDS = 5_000;
    static final long SAVE_RETRY_DELAY_MILLISECONDS = 15_000;

    enum Status {
        OK("ok"),
        FAILING("failing"),
        STILL_FAILING("stillFailing"),
        REFUSED("refused");

        final String wireName;

        Status(String wireName) {
            this.wireName = wireName;
        }
    }

    interface Services {
        long now();

        void write(String positionUrl, ListeningPosition position, WriteCallback callback);

        Runnable setRetryTimer(Runnable callback, long delayMilliseconds);

        void onSaveStateChanged();
    }

    interface WriteCallback {
        void onWritten(Outcome outcome);
    }

    static final class Outcome {
        private final Status status;
        private final String refusalDetail;

        private Outcome(Status status, String refusalDetail) {
            this.status = status;
            this.refusalDetail = refusalDetail;
        }

        static Outcome fromResponse(int httpStatus, String refusalDetail) {
            if (httpStatus >= 200 && httpStatus < 300) {
                return new Outcome(Status.OK, null);
            }
            if (httpStatus >= 400 && httpStatus < 500 && httpStatus != 401 && httpStatus != 429) {
                return new Outcome(Status.REFUSED, refusalDetail == null ? "The server refused the save." : refusalDetail);
            }
            return new Outcome(Status.FAILING, null);
        }

        static Outcome notConnected() {
            return new Outcome(Status.FAILING, null);
        }
    }

    private static final class SaveRequest {
        final ListeningPosition position;
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
    private long latestSaveNumber;
    private Runnable cancelRetryTimer;
    private ListeningPosition retryPosition;
    private Status status = Status.OK;
    private String refusalDetail;
    private Long failingSince;
    private boolean isClosed;

    PositionSaves(ListeningPositions positions, String positionUrl, Services services) {
        this.positions = positions;
        this.positionUrl = positionUrl;
        this.services = services;
    }

    void save(long positionMilliseconds) {
        enqueueSave(positions.at(positionMilliseconds), false);
    }

    void saveIfDue(long positionMilliseconds) {
        if (lastSavedAt != Long.MIN_VALUE && services.now() - lastSavedAt < SAVE_INTERVAL_MILLISECONDS) {
            return;
        }
        save(positionMilliseconds);
    }

    void replacePositionUrl(String url) {
        positionUrl = url;
    }

    void reconnected() {
        if (retryPosition != null) {
            retry();
        }
    }

    void close() {
        isClosed = true;
        disarmRetry();
    }

    Status getStatus() {
        return status;
    }

    String getRefusalDetail() {
        return refusalDetail;
    }

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
            setStatus(Status.REFUSED, outcome.refusalDetail);
            return;
        }
        if (request.saveNumber != latestSaveNumber) {
            return;
        }
        if (failingSince == null) {
            failingSince = services.now();
        }
        boolean hasFailedForRetryDelay = services.now() - failingSince >= SAVE_RETRY_DELAY_MILLISECONDS;
        if (request.isRetry || hasFailedForRetryDelay) {
            setStatus(Status.STILL_FAILING, null);
        } else if (status == Status.OK) {
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
