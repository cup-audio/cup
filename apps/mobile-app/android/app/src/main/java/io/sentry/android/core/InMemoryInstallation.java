package io.sentry.android.core;

import io.sentry.ISentryLifecycleToken;
import java.security.SecureRandom;

public final class InMemoryInstallation {
    private static final SecureRandom RANDOM = new SecureRandom();

    private InMemoryInstallation() {}

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
