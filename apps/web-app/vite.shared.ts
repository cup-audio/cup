import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import wyw from "@wyw-in-js/vite";
import path from "node:path";
import url from "node:url";
import { defineConfig } from "vite";

import { WEB_APP_CSP_NONCE_PLACEHOLDER } from "@cup/listener-api.routes";
import { webReleasePlugin } from "@cup/telemetry.browser/vite";

export const WEB_APP_DIRECTORY = url.fileURLToPath(new URL("./", import.meta.url));
const WYW_CONFIG_FILE = url.fileURLToPath(
  import.meta.resolve("@patricktree-stack/config-wyw-in-js/wyw-in-js.config.cjs"),
);

export function createWebAppViteConfig() {
  return defineConfig({
    build: { assetsDir: "app/assets" },
    html: { cspNonce: WEB_APP_CSP_NONCE_PLACEHOLDER },
    publicDir: path.join(WEB_APP_DIRECTORY, "public"),
    plugins: [
      tanstackRouter({
        addExtensions: ".js",
        autoCodeSplitting: true,
        codeSplittingOptions: {
          defaultBehavior: [["component"], ["notFoundComponent"]],
        },
        generatedRouteTree: path.join(WEB_APP_DIRECTORY, "src/routeTree.gen.ts"),
        routesDirectory: path.join(WEB_APP_DIRECTORY, "src/routes"),
        routeFileIgnorePattern: "\\.(story|test)\\.[jt]sx?$",
        target: "react",
      }),
      wyw({
        configFile: WYW_CONFIG_FILE,
        keepComments: true,
      }),
      react(),
      webReleasePlugin(),
    ],
    server: {
      allowedHosts: [".ts.net"],
      host: "127.0.0.1",
    },
  });
}
