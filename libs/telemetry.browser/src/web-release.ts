/**
 * The `<meta>` name under which the web bundle's `index.html` names its release; the Vite plugin in
 * `web-release.vite.ts` writes it at build time.
 */
export const WEB_RELEASE_META_NAME = "cup-release";

/**
 * The release of the running web bundle, `web@<content hash of the entry chunk>`, or `undefined`
 * when the page was not built, as under Vite's development server.
 */
export function readWebRelease(document: Document): string | undefined {
  const meta = document.querySelector(`meta[name="${WEB_RELEASE_META_NAME}"]`);
  return meta?.getAttribute("content") ?? undefined;
}
