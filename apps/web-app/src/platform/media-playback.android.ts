import { registerPlugin } from "@capacitor/core";

import type { MediaPlaybackPlugin } from "#src/app/player/native-track-player.js";

export const mediaPlaybackPlugin = registerPlugin<MediaPlaybackPlugin>("CupMediaPlayback");
