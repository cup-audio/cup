import type { Plugin } from "vite";

import { WEB_RELEASE_META_NAME } from "#src/web-release.ts";

const RELEASE_HASH_LENGTH = 16;

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
