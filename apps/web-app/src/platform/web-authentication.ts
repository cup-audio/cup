import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export const AUTH_CALLBACK_URL = "audio.cup.app://auth/callback";

type WebAuthenticationPlugin = {
  authenticate(options: {
    url: string;
    sessionStorage?: string;
    ephemeral?: boolean;
  }): Promise<{ url: string }>;
  takePendingCallback(): Promise<{ url?: string; sessionStorage?: string }>;
  addListener(eventName: "pendingCallback", listener: () => void): Promise<PluginListenerHandle>;
};

export const webAuthentication = registerPlugin<WebAuthenticationPlugin>("WebAuthentication");
