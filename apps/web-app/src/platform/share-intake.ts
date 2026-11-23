const CUP_HOSTNAMES = new Set([
  "cup.audio",
  "www.cup.audio",
  "cup-audio.com",
  "www.cup-audio.com",
  "create-audiobook-from-url.patricktree.me",
]);

let pendingUrl: string | undefined;
let formListener: ((url: string) => void) | undefined;

export function receiveSharedUrl(url: string, onShare: () => void | Promise<void>): void {
  if (CUP_HOSTNAMES.has(new URL(url).hostname)) {
    return;
  }
  pendingUrl = url;
  void Promise.resolve(onShare()).then(deliverPendingUrl);
}

export function subscribeToSharedUrl(listener: (url: string) => void): () => void {
  formListener = listener;
  deliverPendingUrl();
  return () => {
    if (formListener === listener) {
      formListener = undefined;
    }
  };
}

export function hasPendingSharedUrl(): boolean {
  return pendingUrl !== undefined;
}

function deliverPendingUrl(): void {
  if (formListener === undefined || pendingUrl === undefined) {
    return;
  }
  const url = pendingUrl;
  pendingUrl = undefined;
  formListener(url);
}
