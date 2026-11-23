export const WEB_RELEASE_META_NAME = "cup-release";

export function readWebRelease(document: Document): string | undefined {
  const meta = document.querySelector(`meta[name="${WEB_RELEASE_META_NAME}"]`);
  return meta?.getAttribute("content") ?? undefined;
}
