import fs from "node:fs";
import path from "node:path";
import { defineConfig, mergeConfig, type Plugin } from "vite";

import { createWebAppViteConfig, WEB_APP_DIRECTORY } from "@cup/web-app/vite";

const GALLERY_PATH = "ui-gallery/index.html";
const SOURCE_MODULE_PATTERN = /^\/src\/(?<modulePath>.+)\.tsx?$/;

function printGalleryUrls(): Plugin {
  return {
    name: "cup:print-gallery-urls",
    apply: "serve",
    configureServer(server) {
      const printUrls = server.printUrls.bind(server);
      server.printUrls = () => {
        const { resolvedUrls } = server;
        if (resolvedUrls) {
          server.resolvedUrls = {
            local: resolvedUrls.local.map((url) => new URL(GALLERY_PATH, url).href),
            network: resolvedUrls.network.map((url) => new URL(GALLERY_PATH, url).href),
          };
        }
        printUrls();
      };
    },
  };
}

function serveSourceModulesAtTheirPaths(): Plugin {
  return {
    name: "cup:serve-source-modules-at-their-paths",
    configurePreviewServer(server) {
      server.middlewares.use((request, _response, next) => {
        const url = new URL(request.url ?? "/", "http://gallery");
        const modulePath = SOURCE_MODULE_PATTERN.exec(url.pathname)?.groups?.["modulePath"];
        if (modulePath !== undefined) {
          request.url = `/src/${modulePath}.js${url.search}`;
        }
        next();
      });
    },
  };
}

function createSourceModuleEntries(): Record<string, string> {
  const sourceFiles = fs.globSync("src/**/*.{ts,tsx}", {
    cwd: WEB_APP_DIRECTORY,
    exclude: ["src/**/*.d.ts", "src/**/*.story.tsx", "src/**/*.test.ts", "src/test-utils/**"],
  });
  return Object.fromEntries(
    sourceFiles.map((sourceFile) => [
      sourceFile.replace(/\.tsx?$/, ""),
      path.join(WEB_APP_DIRECTORY, sourceFile),
    ]),
  );
}

export default mergeConfig(
  createWebAppViteConfig(),
  defineConfig({
    root: WEB_APP_DIRECTORY,
    build: {
      outDir: "playwright-output/gallery",
      emptyOutDir: true,
      rolldownOptions: {
        input: {
          gallery: path.join(WEB_APP_DIRECTORY, GALLERY_PATH),
          ...createSourceModuleEntries(),
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name.startsWith("src/") ? "[name].js" : "app/assets/[name]-[hash].js",
        },
        preserveEntrySignatures: "strict",
      },
    },
    plugins: [printGalleryUrls(), serveSourceModulesAtTheirPaths()],
    server: {
      port: 3100,
      strictPort: true,
    },
  }),
);
