package io.sentry.android.core;

import io.sentry.ISentryLifecycleToken;
import java.security.SecureRandom;

/**
 * Keeps Sentry's installation ID in memory only. Sentry's {@code Installation} writes a random ID
 * to the file {@code INSTALLATION} the first time it needs one and reads it back on every later
 * launch; with {@code deviceId} already set, it never touches the file. This class sits in Sentry's
 * package because {@code Installation} is package-private, so it works only with the
 * {@code sentry-android-core} version the app's build pins and checks.
 */
public final class InMemoryInstallation {
    private static final SecureRandom RANDOM = new SecureRandom();

    private InMemoryInstallation() {}

    /**
     * Gives this process a random installation ID of 32 hex digits, the format Sentry writes, unless
     * it has one. Call it before Sentry can start, from {@code MainActivity.onCreate} before
     * {@code super.onCreate}.
     */
    public static void use() {
        try (ISentryLifecycleToken ignored = Installation.staticLock.acquire()) {
            if (Installation.deviceId == null) {
                Installation.deviceId = randomHex32();
            }
        }
    }

    private static String randomHex32() {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        StringBuilder hex = new StringBuilder(32);
        for (byte value : bytes) {
            hex.append(String.format("%02x", value));
        }
        return hex.toString();
    }
}
