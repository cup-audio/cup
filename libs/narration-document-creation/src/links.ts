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
