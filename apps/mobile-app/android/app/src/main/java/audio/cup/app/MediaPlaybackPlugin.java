package audio.cup.app;

import androidx.annotation.Nullable;
import androidx.media3.common.util.UnstableApi;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/**
 * The page's side of the narration track's {@link PlaybackEngine}: the player port
 * ({@code native-track-player.ts}) drives it through these methods. The page sets the loaded
 * audiobook with {@code load}, which prepares nothing, and the first {@code play} starts the
 * service. After every change of the player, and after a native stop, the plugin sends one
 * {@code state} event; the page asks for {@code getState} whenever it becomes visible, since events
 * sent while the WebView suspends the hidden page can be lost, and when it starts, to take over a
 * session that outlived the previous page.
 *
 * <p>ExoPlayer handles audio focus with speech attributes, so a call or a navigation prompt pauses
 * Cup and resumes it afterwards, and another app's media pauses it for good; it also pauses when
 * headphones disconnect.
 */
@UnstableApi
@CapacitorPlugin(name = "CupMediaPlayback")
public class MediaPlaybackPlugin extends Plugin {
    private final PlaybackEngine.StateListener stateListener = state -> notifyListeners("state", state);

    @Override
    public void load() {
        // The engine outlives this plugin's activity, so a relaunched Cup's page reaches the same session.
        getBridge().executeOnMainThread(() -> engine().setListener(stateListener));
    }

    @Override
    protected void handleOnResume() {
        // Back in the foreground, the connection may be back too: a failed save is retried.
        getBridge().executeOnMainThread(() -> engine().reconnected());
    }

    @Override
    protected void handleOnDestroy() {
        // A playing session outlives the activity; only the page or a native stop ends it.
        getBridge().executeOnMainThread(() -> engine().clearListener(stateListener));
    }

    @PluginMethod
    public void load(PluginCall call) {
        String conversionId = call.getString("conversionId");
        String subject = call.getString("subject");
        String trackUrl = call.getString("trackUrl");
        String positionUrl = call.getString("positionUrl");
        Long urlsIssuedAt = readMilliseconds(call, "urlsIssuedAt");
        ListeningPositions positions = readTimeline(call);
        String title = call.getString("title");
        Long durationMilliseconds = readMilliseconds(call, "durationMilliseconds");
        Long startPositionMilliseconds = readMilliseconds(call, "startPositionMilliseconds");
        if (
            conversionId == null ||
            subject == null ||
            trackUrl == null ||
            positionUrl == null ||
            urlsIssuedAt == null ||
            positions == null ||
            title == null ||
            durationMilliseconds == null ||
            startPositionMilliseconds == null
        ) {
            call.reject(
                "Loading an audiobook needs its conversion, subject, track and position URLs and when they were issued, timeline, title, duration and start."
            );
            return;
        }
        PlaybackEngine.LoadRequest request = new PlaybackEngine.LoadRequest(
            conversionId,
            subject,
            trackUrl,
            positionUrl,
            urlsIssuedAt,
            positions,
            title,
            call.getString("artworkUrl"),
            durationMilliseconds,
            startPositionMilliseconds
        );
        getBridge()
            .executeOnMainThread(() -> {
                engine().load(request);
                call.resolve();
            });
    }

    @PluginMethod
    public void play(PluginCall call) {
        onLoadedEngine(call, PlaybackEngine::play);
    }

    @PluginMethod
    public void pause(PluginCall call) {
        onLoadedEngine(call, PlaybackEngine::pause);
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        Long position = readMilliseconds(call, "positionMilliseconds");
        if (position == null) {
            call.reject("A seek needs a position.");
            return;
        }
        onLoadedEngine(call, engine -> engine.seekTo(position));
    }

    @PluginMethod
    public void skipBy(PluginCall call) {
        Long delta = readMilliseconds(call, "deltaMilliseconds");
        if (delta == null) {
            call.reject("A skip needs an amount.");
            return;
        }
        onLoadedEngine(call, engine -> engine.skipBy(delta));
    }

    @PluginMethod
    public void replaceUrls(PluginCall call) {
        String trackUrl = call.getString("trackUrl");
        String positionUrl = call.getString("positionUrl");
        Long urlsIssuedAt = readMilliseconds(call, "urlsIssuedAt");
        if (trackUrl == null || positionUrl == null || urlsIssuedAt == null) {
            call.reject("Replacing the URLs needs a track and a position URL and when they were issued.");
            return;
        }
        onLoadedEngine(call, engine -> engine.replaceUrls(trackUrl, positionUrl, urlsIssuedAt));
    }

    /**
     * Ends the session; the service stops, which removes the notification and releases the player.
     * `position` is `"save"` for one final save, or `"discard"`.
     */
    @PluginMethod
    public void close(PluginCall call) {
        String position = call.getString("position");
        PlaybackEngine.PositionOnClose positionOnClose;
        if ("save".equals(position)) {
            positionOnClose = PlaybackEngine.PositionOnClose.SAVE;
        } else if ("discard".equals(position)) {
            positionOnClose = PlaybackEngine.PositionOnClose.DISCARD;
        } else {
            call.reject("Closing needs the position to \"save\" or \"discard\".");
            return;
        }
        getBridge()
            .executeOnMainThread(() -> {
                engine().close(positionOnClose);
                call.resolve();
            });
    }

    @PluginMethod
    public void getState(PluginCall call) {
        getBridge()
            .executeOnMainThread(() -> {
                JSObject state = engine().readState();
                JSObject result = new JSObject();
                result.put("state", state == null ? JSObject.NULL : state);
                call.resolve(result);
            });
    }

    private PlaybackEngine engine() {
        return PlaybackEngine.get(getContext());
    }

    private interface EngineCommand {
        /** Returns false when no audiobook is loaded. */
        boolean run(PlaybackEngine engine);
    }

    private void onLoadedEngine(PluginCall call, EngineCommand command) {
        getBridge()
            .executeOnMainThread(() -> {
                if (command.run(engine())) {
                    call.resolve();
                } else {
                    call.reject("No audiobook is loaded.");
                }
            });
    }

    /**
     * The `timeline` of a load, each synchronization unit's `synchronizationUnitId` and
     * `startMilliseconds` in document order, or null when it is missing or malformed.
     */
    @Nullable
    private static ListeningPositions readTimeline(PluginCall call) {
        JSArray timeline = call.getArray("timeline");
        if (timeline == null || timeline.length() == 0) {
            return null;
        }
        String[] unitIds = new String[timeline.length()];
        long[] startMilliseconds = new long[timeline.length()];
        for (int index = 0; index < timeline.length(); index += 1) {
            JSONObject unit = timeline.optJSONObject(index);
            Object start = unit == null ? null : unit.opt("startMilliseconds");
            String unitId = unit == null ? null : unit.optString("synchronizationUnitId", null);
            if (unitId == null || !(start instanceof Number)) {
                return null;
            }
            unitIds[index] = unitId;
            startMilliseconds[index] = Math.round(((Number) start).doubleValue());
        }
        return new ListeningPositions(unitIds, startMilliseconds);
    }

    /**
     * A whole number of milliseconds. JavaScript numbers arrive as integers, longs or doubles, and
     * `PluginCall.getDouble` reads no long, such as an epoch time.
     */
    @Nullable
    private static Long readMilliseconds(PluginCall call, String name) {
        Object value = call.getData().opt(name);
        return value instanceof Number ? Math.round(((Number) value).doubleValue()) : null;
    }
}
