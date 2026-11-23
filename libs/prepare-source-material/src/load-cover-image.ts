import { CupError } from "@cup/errors";

import {
  assertPublicSourceUrl,
  type CoverImageDeclaration,
  type SourcePageCookie,
} from "#src/prepare-source-material.ts";

export const COVER_IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
] as const;
export type CoverImageContentType = (typeof COVER_IMAGE_CONTENT_TYPES)[number];

export type CoverImageRefusalReason =
  | "non-public-destination"
  | "http-error"
  | "too-large"
  | "unsupported-type";

export type LoadCoverImageResult =
  | { result: "loaded"; bytes: Uint8Array; contentType: CoverImageContentType }
  | { result: "refused"; reason: CoverImageRefusalReason };

export type CoverImageLoader = (
  declaration: CoverImageDeclaration,
  sourceUrl: string,
) => Promise<LoadCoverImageResult>;

type RedirectedRequest = {
  url(): string;
  redirectedFrom(): RedirectedRequest | null;
};
type CoverImageResponse = {
  status(): number;
  headers(): Record<string, string>;
  body(): Promise<Uint8Array>;
  request(): RedirectedRequest;
};
type InterceptedRoute = {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode: "blockedbyclient"): Promise<void>;
};
type CoverImagePage = {
  route(pattern: string, handler: (route: InterceptedRoute) => Promise<void>): Promise<unknown>;
  context(): {
    addCookies(cookies: SourcePageCookie[]): Promise<void>;
  };
  setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
  goto(
    url: string,
    options: { referer: string; timeout: number; waitUntil: "commit" },
  ): Promise<CoverImageResponse | null>;
  close(): Promise<void>;
};

export type CoverImageBrowser = {
  newPage(options: { javaScriptEnabled: boolean }): Promise<CoverImagePage>;
};

export type LoadCoverImageOptions = {
  browser: CoverImageBrowser;
  cookies?: SourcePageCookie[];
  declaration: CoverImageDeclaration;
  sourceUrl: string;
};

export const MAX_COVER_IMAGE_BYTES = 10 * 1024 * 1024;
const COVER_IMAGE_TIMEOUT_MS = 10_000;

export async function loadCoverImage({
  browser,
  cookies = [],
  declaration,
  sourceUrl,
}: LoadCoverImageOptions): Promise<LoadCoverImageResult> {
  if (!isPublicUrl(declaration.url)) {
    return { result: "refused", reason: "non-public-destination" };
  }

  const page = await browser.newPage({ javaScriptEnabled: false });

  try {
    await page.route("**/*", async (route: InterceptedRoute) => {
      if (isPublicUrl(route.request().url())) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    if (cookies.length > 0) {
      await page.context().addCookies(cookies);
    }
    await page.setExtraHTTPHeaders({ Accept: `${COVER_IMAGE_CONTENT_TYPES.join(",")},*/*;q=0.5` });

    const response = await page.goto(declaration.url, {
      referer: sourceUrl,
      timeout: COVER_IMAGE_TIMEOUT_MS,
      waitUntil: "commit",
    });

    if (!response) {
      throw new CupError("Expected cover-image navigation to return an HTTP response");
    }

    if (!getRedirectChainUrls(response.request()).every(isPublicUrl)) {
      return { result: "refused", reason: "non-public-destination" };
    }

    if (response.status() < 200 || response.status() >= 300) {
      return { result: "refused", reason: "http-error" };
    }

    if (Number(response.headers()["content-length"]) > MAX_COVER_IMAGE_BYTES) {
      return { result: "refused", reason: "too-large" };
    }

    const bytes = await rejectAfterTimeout(response.body(), COVER_IMAGE_TIMEOUT_MS);

    if (bytes.byteLength > MAX_COVER_IMAGE_BYTES) {
      return { result: "refused", reason: "too-large" };
    }

    const contentType = detectCoverImageContentType(bytes);

    return contentType === undefined
      ? { result: "refused", reason: "unsupported-type" }
      : { result: "loaded", bytes, contentType };
  } finally {
    await page.close();
  }
}

export function detectCoverImageContentType(bytes: Uint8Array): CoverImageContentType | undefined {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 12) === "WEBP") {
    return "image/webp";
  }

  if (readAscii(bytes, 4, 8) === "ftyp" && listFileTypeBrands(bytes).includes("avif")) {
    return "image/avif";
  }

  if (["GIF87a", "GIF89a"].includes(readAscii(bytes, 0, 6))) {
    return "image/gif";
  }

  return undefined;
}

function isPublicUrl(url: string): boolean {
  try {
    assertPublicSourceUrl(url);
    return true;
  } catch {
    return false;
  }
}

function getRedirectChainUrls(finalRequest: RedirectedRequest): string[] {
  const urls: string[] = [];

  for (
    let request: RedirectedRequest | null = finalRequest;
    request !== null;
    request = request.redirectedFrom()
  ) {
    urls.push(request.url());
  }

  return urls;
}

async function rejectAfterTimeout<Value>(
  promise: Promise<Value>,
  timeoutMilliseconds: number,
): Promise<Value> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new CupError(`Cover image was not received within ${timeoutMilliseconds} ms`));
        }, timeoutMilliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function readAscii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCodePoint(...bytes.subarray(start, end));
}

function listFileTypeBrands(bytes: Uint8Array): string[] {
  const boxLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const boxEnd = Math.min(boxLength, bytes.byteLength);
  const brands = [readAscii(bytes, 8, 12)];

  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    brands.push(readAscii(bytes, offset, offset + 4));
  }

  return brands;
}
