export function toSourceHost(sourceUrl: string): string {
  if (!URL.canParse(sourceUrl)) {
    return sourceUrl;
  }

  return new URL(sourceUrl).hostname.replace(/^www\./, "");
}
