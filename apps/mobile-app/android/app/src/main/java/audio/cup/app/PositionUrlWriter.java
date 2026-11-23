package audio.cup.app;

import android.os.Handler;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

final class PositionUrlWriter {
    private static final String TAG = "CupPositionSaves";
    private static final int TIMEOUT_MILLISECONDS = 15_000;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler handler;

    PositionUrlWriter(Handler handler) {
        this.handler = handler;
    }

    void write(String positionUrl, ListeningPosition position, PositionSaves.WriteCallback callback) {
        executor.execute(() -> {
            PositionSaves.Outcome outcome = send(positionUrl, position);
            handler.post(() -> callback.onWritten(outcome));
        });
    }

    private static PositionSaves.Outcome send(String positionUrl, ListeningPosition position) {
        HttpURLConnection connection = null;
        try {
            byte[] body = new JSONObject()
                .put("synchronizationUnitId", position.synchronizationUnitId)
                .put("offsetMilliseconds", position.offsetMilliseconds)
                .toString()
                .getBytes(StandardCharsets.UTF_8);
            connection = (HttpURLConnection) new URL(positionUrl).openConnection();
            connection.setRequestMethod("PUT");
            connection.setConnectTimeout(TIMEOUT_MILLISECONDS);
            connection.setReadTimeout(TIMEOUT_MILLISECONDS);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(body.length);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("X-Create-Audiobook-From-URL-Request", "1");
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }
            int status = connection.getResponseCode();
            PositionSaves.Outcome outcome = PositionSaves.Outcome.fromResponse(status, readErrorMessage(connection, status));
            if (status >= 300) {
                Log.w(TAG, "The position route answered a save with " + status + ".");
            }
            return outcome;
        } catch (IOException | JSONException error) {
            Log.w(TAG, "A listening-position save failed without an answer.", error);
            return PositionSaves.Outcome.notConnected();
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String readErrorMessage(HttpURLConnection connection, int status) {
        if (status < 400) {
            return null;
        }
        try (InputStream stream = connection.getErrorStream()) {
            if (stream == null) {
                return null;
            }
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[4_096];
            for (int read = stream.read(buffer); read != -1; read = stream.read(buffer)) {
                bytes.write(buffer, 0, read);
            }
            JSONObject error = new JSONObject(bytes.toString("UTF-8")).optJSONObject("error");
            String message = error == null ? null : error.optString("message", "");
            return message == null || message.isEmpty() ? null : message;
        } catch (IOException | JSONException error) {
            return null;
        }
    }
}
