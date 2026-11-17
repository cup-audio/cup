import { registerPlugin } from "@capacitor/core";

import type { MediaPlaybackPlugin } from "#src/app/player/native-track-player.js";

/** The Android app's native player, `MediaPlaybackPlugin.java`. */
export const mediaPlaybackPlugin = registerPlugin<MediaPlaybackPlugin>("CupMediaPlayback");
