/**
 * Resolves a link's `href` against the URL of the page it came from. Returns the absolute URL of a
 * link the narration document keeps, or `undefined` for one it shows as plain text: a link that
 * can't be resolved, one with a scheme other than `http:` or `https:`, and one to the page itself.
 */
export function resolveLink({
  href,
  baseUrl,
}: {
  href: string | undefined;
  baseUrl: string;
}): string | undefined {
  if (href === undefined || href.trim().length === 0 || href.trim().startsWith("#")) {
    return undefined;
  }

  let url: URL;
  let pageUrl: URL;

  try {
    url = new URL(href, baseUrl);
    pageUrl = new URL(baseUrl);
  } catch {
    return undefined;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }

  // A footnote or other jump within the page, or a link to the page itself, would leave Cup only to
  // land on the publisher's copy of the text the listener is already reading.
  if (withoutHash(url) === withoutHash(pageUrl)) {
    return undefined;
  }

  return url.href;
}

function withoutHash(url: URL): string {
  const urlWithoutHash = new URL(url);

  urlWithoutHash.hash = "";

  return urlWithoutHash.href;
}
