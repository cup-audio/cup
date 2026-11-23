package audio.cup.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import androidx.browser.auth.AuthTabIntent;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "WebAuthentication")
public class WebAuthenticationPlugin extends Plugin {
    private static final String CALLBACK_SCHEME = "audio.cup.app";
    private static final String CALLBACK_HOST = "auth";
    private static final String CALLBACK_PATH = "/callback";
    private static final String PREFERENCES = "audio.cup.app.web_authentication";
    private static final String SESSION_STORAGE = "sessionStorage";

    private PluginCall customTabCall;
    private String pendingCallbackUrl;

    @Override
    public void load() {
        receiveCallback(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        receiveCallback(intent);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        String value = call.getString("url");
        Uri url = value == null ? null : Uri.parse(value);
        if (url == null || !isAllowedSignInUrl(url)) {
            call.reject("The sign-in URL is not one Cup opens.", "INVALID_URL");
            return;
        }
        keepSessionStorage(call.getString(SESSION_STORAGE));
        boolean ephemeral = Boolean.TRUE.equals(call.getBoolean("ephemeral", false));
        getActivity().runOnUiThread(() -> open(call, url, ephemeral));
    }

    @PluginMethod
    public void takePendingCallback(PluginCall call) {
        JSObject result = new JSObject();
        if (pendingCallbackUrl != null) {
            result.put("url", pendingCallbackUrl);
            String sessionStorage = preferences().getString(SESSION_STORAGE, null);
            if (sessionStorage != null) {
                result.put(SESSION_STORAGE, sessionStorage);
            }
            pendingCallbackUrl = null;
            keepSessionStorage(null);
        }
        call.resolve(result);
    }

    @ActivityCallback
    private void authTabResult(PluginCall call, ActivityResult result) {
        AuthTabIntent.AuthResult authResult = new AuthTabIntent.AuthenticateUserResultContract()
            .parseResult(result.getResultCode(), result.getData());
        boolean isWaiting = call != null && !PluginCall.CALLBACK_ID_DANGLING.equals(call.getCallbackId());
        if (authResult.resultCode == AuthTabIntent.RESULT_OK && authResult.resultUri != null) {
            String callbackUrl = authResult.resultUri.toString();
            if (isWaiting) {
                keepSessionStorage(null);
                call.resolve(callbackResult(callbackUrl));
            } else {
                pendingCallbackUrl = callbackUrl;
            }
            return;
        }
        if (!isWaiting) {
            return;
        }
        keepSessionStorage(null);
        if (authResult.resultCode == AuthTabIntent.RESULT_CANCELED) {
            call.reject("Sign-in was cancelled.", "CANCELED");
        } else {
            call.reject("Sign-in failed with Auth Tab result " + authResult.resultCode + ".", "FAILED");
        }
    }

    private void open(PluginCall call, Uri url, boolean ephemeral) {
        if (customTabCall != null) {
            customTabCall.reject("Sign-in was cancelled.", "CANCELED");
            customTabCall = null;
        }
        String browser = CustomTabsClient.getPackageName(getContext(), null);
        try {
            if (browser != null && CustomTabsClient.isAuthTabSupported(getContext(), browser)) {
                Intent intent = new AuthTabIntent.Builder().setEphemeralBrowsingEnabled(ephemeral).build().intent;
                intent.setPackage(browser);
                intent.setData(url);
                intent.putExtra(AuthTabIntent.EXTRA_REDIRECT_SCHEME, CALLBACK_SCHEME);
                startActivityForResult(call, intent, "authTabResult");
                return;
            }
            customTabCall = call;
            CustomTabsIntent customTab = new CustomTabsIntent.Builder().setEphemeralBrowsingEnabled(ephemeral).build();
            if (browser != null) {
                customTab.intent.setPackage(browser);
            }
            customTab.launchUrl(getActivity(), url);
        } catch (RuntimeException error) {
            customTabCall = null;
            call.reject("Sign-in could not start.", "FAILED", error);
        }
    }

    private void receiveCallback(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || !isCallback(intent.getData())) {
            return;
        }
        String callbackUrl = intent.getData().toString();
        intent.setAction(Intent.ACTION_MAIN);
        intent.setData(null);
        if (customTabCall != null) {
            keepSessionStorage(null);
            customTabCall.resolve(callbackResult(callbackUrl));
            customTabCall = null;
        } else {
            pendingCallbackUrl = callbackUrl;
        }
    }

    private void keepSessionStorage(String sessionStorage) {
        SharedPreferences.Editor editor = preferences().edit();
        if (sessionStorage == null) {
            editor.remove(SESSION_STORAGE);
        } else {
            editor.putString(SESSION_STORAGE, sessionStorage);
        }
        editor.apply();
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static JSObject callbackResult(String callbackUrl) {
        JSObject result = new JSObject();
        result.put("url", callbackUrl);
        return result;
    }

    private static boolean isCallback(Uri uri) {
        return (
            uri != null &&
            CALLBACK_SCHEME.equals(uri.getScheme()) &&
            CALLBACK_HOST.equals(uri.getHost()) &&
            CALLBACK_PATH.equals(uri.getPath())
        );
    }

    private boolean isAllowedSignInUrl(Uri url) {
        if ("https".equals(url.getScheme())) {
            return true;
        }
        boolean isDebuggable = (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        return isDebuggable && "http".equals(url.getScheme()) && "localhost".equals(url.getHost());
    }
}
