export const APPLICATION_ORIGIN = "https://cup.audio";

const REDIRECTED_HOSTNAMES = new Set([
  "www.cup.audio",
  "cup-audio.com",
  "www.cup-audio.com",
  "create-audiobook-from-url.patricktree.me",
]);

export function routeApplicationDomain(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (!REDIRECTED_HOSTNAMES.has(url.hostname)) {
    return undefined;
  }

  return Response.redirect(`${APPLICATION_ORIGIN}${url.pathname}${url.search}`, 308);
}
