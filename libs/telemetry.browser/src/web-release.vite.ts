import type { Plugin } from "vite";

import { WEB_RELEASE_META_NAME } from "#src/web-release.ts";

/** Enough of the SHA-256 to tell bundles apart in Sentry's release list. */
const RELEASE_HASH_LENGTH = 16;

/**
 * Names the web bundle's release `web@<content hash of the entry chunk>` in a `<meta>` of the built
 * `index.html`, which `readWebRelease` reads at runtime. The entry chunk imports every other chunk
 * by its hashed file name, so the hash changes exactly when the bundle's code does: an unchanged
 * bundle keeps its release, and Turbo can replay E2E suites that ran it. The release cannot live in
 * the entry chunk itself, whose hash would then depend on it.
 */
export function webReleasePlugin(): Plugin {
  return {
    name: "cup:web-release",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      async handler(_html, { chunk }) {
        if (chunk === undefined) {
          throw new Error("The web release needs the page's entry chunk, which Vite did not pass.");
        }
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(chunk.code));
        const hash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        )
          .join("")
          .slice(0, RELEASE_HASH_LENGTH);
        return [
          {
            tag: "meta",
            attrs: { name: WEB_RELEASE_META_NAME, content: `web@${hash}` },
            injectTo: "head",
          },
        ];
      },
    },
  };
}
