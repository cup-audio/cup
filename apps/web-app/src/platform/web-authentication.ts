import { registerPlugin } from "@capacitor/core";

export const AUTH_CALLBACK_URL = "audio.cup.app://auth/callback";

type WebAuthenticationPlugin = {
  authenticate(options: { url: string; sessionStorage?: string }): Promise<{ url: string }>;
  takePendingCallback(): Promise<{ url?: string; sessionStorage?: string }>;
};

export const webAuthentication = registerPlugin<WebAuthenticationPlugin>("WebAuthentication");
