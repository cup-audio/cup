import { parseFragment, serialize } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";

import { CupError } from "@cup/errors";

import {
  collectMetadata,
  extractNodeText,
  findAllElements,
  findFirstElement,
  getAttribute,
  isTemplateElement,
  NARRATION_TEXT_ELEMENT_TAG_NAMES,
  normalizeWhitespace,
  type HtmlElement,
  type HtmlParentNode,
  type Metadata,
} from "#src/html-tree.ts";
import { extractMetadataDescriptions, findSourceSubtitleElement } from "#src/source-subtitle.ts";

export type SourcePageCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
};

const MEANINGFUL_EMPTY_ELEMENT_TAG_NAMES = new Set<string>([
  "audio",
  "br",
  "canvas",
  "embed",
  "hr",
  "iframe",
  "img",
  "object",
  "source",
  "track",
  "video",
  "wbr",
]);

const IRRELEVANT_ELEMENT_TAG_NAMES = new Set<string>([
  "button",
  "figure",
  "footer",
  "form",
  "input",
  "nav",
  "noscript",
  "script",
  "style",
  "svg",
]);
export const VISIBLE_HEADING_ATTRIBUTE = "data-cup-visible-heading";
export const SCREEN_READER_ONLY_CONTENT_ATTRIBUTE = "data-cup-screen-reader-only";
const BETTER_SOURCE_MATERIAL_TEXT_FACTOR = 1.1;
const SOURCE_PAGE_JAVASCRIPT_MODES = [false, true] as const;
const MAX_COVER_IMAGE_URL_LENGTH = 2048;
const MAX_COVER_IMAGE_ALTERNATIVE_TEXT_LENGTH = 500;
const OPEN_GRAPH_IMAGE_URL_PROPERTIES = [
  "og:image:secure_url",
  "og:image",
  "og:image:url",
] as const;
const TWITTER_IMAGE_URL_PROPERTIES = ["twitter:image", "twitter:image:src"] as const;
const METADATA_TITLE_PROPERTIES = ["og:title", "twitter:title"] as const;
const DOCUMENT_TITLE_SEPARATOR_PATTERN = /(\s[|·•»–—-]\s)/u;
const RENDERED_SOURCE_PAGE_READY_TIMEOUT_MS = 30_000;
const RENDERED_SOURCE_PAGE_READINESS = {
  minimumBlockCount: 2,
  minimumLongTextLength: 500,
  minimumTextLength: 200,
  narrationTextSelector: "blockquote, figcaption, h1, h2, h3, h4, h5, h6, li, p, pre, td, th",
} as const;
const NON_PUBLIC_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00_00_00_00, 0x00_ff_ff_ff],
  [0x0a_00_00_00, 0x0a_ff_ff_ff],
  [0x64_40_00_00, 0x64_7f_ff_ff],
  [0x7f_00_00_00, 0x7f_ff_ff_ff],
  [0xa9_fe_00_00, 0xa9_fe_ff_ff],
  [0xac_10_00_00, 0xac_1f_ff_ff],
  [0xc0_00_00_00, 0xc0_00_00_ff],
  [0xc0_a8_00_00, 0xc0_a8_ff_ff],
  [0xc6_12_00_00, 0xc6_13_ff_ff],
  [0xe0_00_00_00, 0xff_ff_ff_ff],
];

type RenderedSourcePageReadinessOptions = typeof RENDERED_SOURCE_PAGE_READINESS;
type SourcePage = {
  route(pattern: string, handler: (route: InterceptedRoute) => Promise<void>): Promise<unknown>;
  context(): {
    addCookies(cookies: SourcePageCookie[]): Promise<void>;
  };
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded" },
  ): Promise<{ status(): number; url(): string } | null>;
  waitForFunction(
    pageFunction: (options: RenderedSourcePageReadinessOptions) => boolean,
    argument: RenderedSourcePageReadinessOptions,
    options: { timeout: number },
  ): Promise<unknown>;
  evaluate(pageFunction: (attributeName: string) => void, attributeName: string): Promise<unknown>;
  locator(selector: "body" | "head" | "html"): {
    innerHTML(): Promise<string>;
    getAttribute(name: string): Promise<string | null>;
  };
  title(): Promise<string>;
  close(): Promise<void>;
};

export type Browser = {
  newPage(options: { javaScriptEnabled: boolean }): Promise<SourcePage>;
};
type InterceptedRoute = {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode: "blockedbyclient"): Promise<void>;
};

export type CoverImageDeclaration = {
  url: string;
  alternativeText?: string;
};

export type DeclaredLanguage = {
  htmlLang?: string;
  ogLocale?: string;
};

export type SourceMaterial = {
  html: string;
  title: string;
  fetchedUrl: string;
  subtitle?: string;
  coverImage?: CoverImageDeclaration;
  declaredLanguage?: DeclaredLanguage;
};

export type SourceMaterialPreparer = (url: string) => Promise<SourceMaterial>;

export type LoadSourcePageOptions = {
  cookies?: SourcePageCookie[];
  browser: Browser;
  javaScriptEnabled: boolean;
  url: string;
};

export type LoadedSourcePage = {
  bodyHtml: string;
  documentTitle: string;
  metadataTitle?: string;
  siteName?: string;
  metadataDescriptions?: readonly string[];
  coverImage?: CoverImageDeclaration;
  declaredLanguage?: DeclaredLanguage;
  fetchedUrl: string;
  responseStatus: number;
};

export type SourcePageLoader = (options: LoadSourcePageOptions) => Promise<LoadedSourcePage>;

export type PrepareOptions = Omit<LoadSourcePageOptions, "javaScriptEnabled"> & {
  loadSourcePage?: SourcePageLoader;
};

export async function prepareSourceMaterial({
  browser,
  cookies = [],
  url,
  loadSourcePage = loadPublicSourcePage,
}: PrepareOptions): Promise<SourceMaterial> {
  const results = await Promise.allSettled(
    SOURCE_PAGE_JAVASCRIPT_MODES.map(async (javaScriptEnabled) =>
      prepareLoadedSourcePage(await loadSourcePage({ browser, cookies, javaScriptEnabled, url })),
    ),
  );
  const sourceMaterials = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );

  if (sourceMaterials.length > 0) {
    const { html, title, subtitle, fetchedUrl, declaredLanguage } =
      selectBetterSourceMaterial(sourceMaterials);
    const coverImage = sourceMaterials.at(-1)?.coverImage ?? sourceMaterials[0]?.coverImage;

    return {
      html,
      title,
      ...(subtitle === undefined ? {} : { subtitle }),
      fetchedUrl,
      ...(coverImage === undefined ? {} : { coverImage }),
      ...(declaredLanguage === undefined ? {} : { declaredLanguage }),
    };
  }

  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  const failureDescriptions = results.map((result, resultIndex) => {
    const loadMode = SOURCE_PAGE_JAVASCRIPT_MODES[resultIndex] ? "rendered" : "static";
    return `${loadMode}: ${result.status === "rejected" ? describeError(result.reason) : "no usable source material"}`;
  });

  throw new AggregateError(
    failures,
    `Expected at least one source-page load to produce audiobook source material (${failureDescriptions.join("; ")})`,
  );
}

export function prepareLoadedSourcePage(sourcePage: LoadedSourcePage): SourceMaterial {
  if (sourcePage.responseStatus < 200 || sourcePage.responseStatus >= 300) {
    throw new CupError(`Source page responded with HTTP ${sourcePage.responseStatus}`);
  }

  const documentFragment = parseFragment(sourcePage.bodyHtml);

  removeScreenReaderOnlyContent(documentFragment);
  removeSiteHeadings(documentFragment, sourcePage);

  const visibleHeadline = findFirstElement(
    documentFragment,
    (element) => getAttribute(element, VISIBLE_HEADING_ATTRIBUTE) !== undefined,
  );
  const title = visibleHeadline
    ? normalizeWhitespace(extractNodeText(visibleHeadline))
    : selectMetadataTitle(sourcePage);

  if (title.length === 0) {
    throw new CupError("Expected the source page to have a title");
  }

  if (visibleHeadline) {
    cutBeforeAndIncluding(visibleHeadline);
  }
  removeAttribute(documentFragment, VISIBLE_HEADING_ATTRIBUTE);
  removeIrrelevantAndEmptyElements(documentFragment);

  const subtitleElement = visibleHeadline
    ? findSourceSubtitleElement(documentFragment, title, sourcePage.metadataDescriptions ?? [])
    : undefined;
  const subtitle = subtitleElement && normalizeWhitespace(extractNodeText(subtitleElement));

  if (subtitleElement) {
    removeElement(subtitleElement);
    removeIrrelevantAndEmptyElements(documentFragment);
  }

  return {
    html: serialize(documentFragment),
    title,
    ...(subtitle === undefined ? {} : { subtitle }),
    fetchedUrl: sourcePage.fetchedUrl,
    ...(sourcePage.coverImage === undefined ? {} : { coverImage: sourcePage.coverImage }),
    ...(sourcePage.declaredLanguage === undefined
      ? {}
      : { declaredLanguage: sourcePage.declaredLanguage }),
  };
}

function removeSiteHeadings(parentNode: HtmlParentNode, sourcePage: LoadedSourcePage): void {
  const siteHeadings = findAllElements(
    parentNode,
    (element) => element.tagName === "h1" && isSiteHeading(element, sourcePage),
  );

  for (const siteHeading of siteHeadings) {
    removeElement(siteHeading);
  }
}

function isSiteHeading(
  heading: HtmlElement,
  { fetchedUrl, siteName }: Pick<LoadedSourcePage, "fetchedUrl" | "siteName">,
): boolean {
  const headingText = toComparableText(extractNodeText(heading));

  if (headingText.length === 0) {
    return false;
  }

  if (siteName !== undefined && headingText === toComparableText(siteName)) {
    return true;
  }

  if (new URL(fetchedUrl).pathname === "/") {
    return false;
  }

  const enclosingLink = findAncestorElement(heading, (element) => element.tagName === "a");
  const links = [
    ...(enclosingLink ? [enclosingLink] : []),
    ...findAllElements(heading, (element) => element.tagName === "a"),
  ];

  return links.some(
    (link) =>
      isFrontPageLink(link, fetchedUrl) && toComparableText(extractNodeText(link)) === headingText,
  );
}

function isFrontPageLink(element: HtmlElement, fetchedUrl: string): boolean {
  const href = getAttribute(element, "href");

  if (element.tagName !== "a" || href === undefined || !URL.canParse(href, fetchedUrl)) {
    return false;
  }

  const url = new URL(href, fetchedUrl);

  return url.origin === new URL(fetchedUrl).origin && url.pathname === "/";
}

function findAncestorElement(
  element: HtmlElement,
  isMatch: (ancestor: HtmlElement) => boolean,
): HtmlElement | undefined {
  let ancestor = element.parentNode;

  while (ancestor && "tagName" in ancestor) {
    if (isMatch(ancestor)) {
      return ancestor;
    }

    ancestor = ancestor.parentNode;
  }

  return undefined;
}

function selectMetadataTitle({
  documentTitle,
  metadataTitle,
  siteName,
}: Pick<LoadedSourcePage, "documentTitle" | "metadataTitle" | "siteName">): string {
  const comparableSiteName = siteName === undefined ? undefined : toComparableText(siteName);
  const candidates = [metadataTitle, removeSiteNameFromDocumentTitle(documentTitle, siteName)]
    .map((candidate) => normalizeWhitespace(candidate ?? ""))
    .filter(
      (candidate) => candidate.length > 0 && toComparableText(candidate) !== comparableSiteName,
    );

  return candidates[0] ?? normalizeWhitespace(documentTitle);
}

function removeSiteNameFromDocumentTitle(documentTitle: string, siteName?: string): string {
  if (siteName === undefined) {
    return documentTitle;
  }

  const comparableSiteName = toComparableText(siteName);
  const parts = normalizeWhitespace(documentTitle).split(DOCUMENT_TITLE_SEPARATOR_PATTERN);
  const isSiteNamePart = (part: string | undefined) =>
    part !== undefined && toComparableText(part) === comparableSiteName;

  if (parts.length >= 3 && isSiteNamePart(parts.at(-1))) {
    parts.splice(-2);
  }

  if (parts.length >= 3 && isSiteNamePart(parts[0])) {
    parts.splice(0, 2);
  }

  return parts.join("");
}

function toComparableText(text: string): string {
  return normalizeWhitespace(text).replace(/[‘’]/gu, "'").toLowerCase();
}

function removeElement(element: HtmlElement): void {
  const { parentNode } = element;

  if (!parentNode) {
    throw new CupError("Expected the removed element to have a parent node");
  }

  parentNode.childNodes.splice(parentNode.childNodes.indexOf(element), 1);
}

export async function loadPublicSourcePage({
  browser,
  cookies = [],
  javaScriptEnabled,
  url,
}: LoadSourcePageOptions): Promise<LoadedSourcePage> {
  const page = await browser.newPage({ javaScriptEnabled });

  try {
    assertPublicSourceUrl(url);
    await page.route("**/*", async (route: InterceptedRoute) => {
      try {
        assertPublicSourceUrl(route.request().url());
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    if (cookies.length > 0) {
      await page.context().addCookies(cookies);
    }
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });

    if (!response) {
      throw new CupError("Expected source-page navigation to return an HTTP response");
    }

    if (javaScriptEnabled) {
      await page.waitForFunction(
        (options) => {
          const title = document.querySelector("h1")?.textContent?.trim() || document.title.trim();

          if (!title) {
            return false;
          }

          const semanticContentRoots = Array.from(
            document.querySelectorAll("article, main"),
          ).filter((element) => element.querySelector(options.narrationTextSelector));
          const contentRoots =
            semanticContentRoots.length > 0 ? semanticContentRoots : [document.body];

          return contentRoots.some((contentRoot) => {
            const narrationBlocks = Array.from(
              contentRoot.querySelectorAll(options.narrationTextSelector),
            )
              .filter((element) => !element.closest("footer, form, nav"))
              .map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
              .filter((text) => text.length > 0);
            const narrationTextLength = narrationBlocks.reduce(
              (totalLength, text) => totalLength + text.length,
              0,
            );

            return (
              narrationTextLength >= options.minimumLongTextLength ||
              (narrationBlocks.length >= options.minimumBlockCount &&
                narrationTextLength >= options.minimumTextLength)
            );
          });
        },
        RENDERED_SOURCE_PAGE_READINESS,
        { timeout: RENDERED_SOURCE_PAGE_READY_TIMEOUT_MS },
      );
    }

    const headHtml = await page.locator("head").innerHTML();
    const headMetadata = collectMetadata(parseFragment(headHtml));
    const metadataTitle = METADATA_TITLE_PROPERTIES.map((property) =>
      findMetadataContent(headMetadata, property),
    ).find((content) => content !== undefined);
    const siteName = findMetadataContent(headMetadata, "og:site_name");
    const coverImage = extractCoverImageDeclaration(headHtml, url);
    const declaredLanguage = extractDeclaredLanguage(
      await page.locator("html").getAttribute("lang"),
      headHtml,
    );
    await page.evaluate(markVisibleHeadings, VISIBLE_HEADING_ATTRIBUTE);
    await page.evaluate(markScreenReaderOnlyContent, SCREEN_READER_ONLY_CONTENT_ATTRIBUTE);
    const bodyHtml = await page.locator("body").innerHTML();

    return {
      bodyHtml,
      documentTitle: await page.title(),
      ...(metadataTitle === undefined ? {} : { metadataTitle }),
      ...(siteName === undefined ? {} : { siteName }),
      metadataDescriptions: extractMetadataDescriptions(`${headHtml}${bodyHtml}`),
      ...(coverImage === undefined ? {} : { coverImage }),
      ...(declaredLanguage === undefined ? {} : { declaredLanguage }),
      fetchedUrl: response.url(),
      responseStatus: response.status(),
    };
  } finally {
    await page.close();
  }
}

function markVisibleHeadings(attributeName: string): void {
  const visibleHeadlines = Array.from(document.querySelectorAll("h1")).filter((heading) => {
    const boundingRectangle = heading.getBoundingClientRect();

    return (
      (heading.textContent?.trim() ?? "").length > 0 &&
      heading.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
      boundingRectangle.width > 1 &&
      boundingRectangle.height > 1
    );
  });

  for (const visibleHeadline of visibleHeadlines) {
    visibleHeadline.setAttribute(attributeName, "");
  }
}

function markScreenReaderOnlyContent(attributeName: string): void {
  const markScreenReaderOnlyDescendants = (parentElement: Element): void => {
    for (const element of Array.from(parentElement.children)) {
      const style = getComputedStyle(element);
      const hasOwnBox = style.display !== "contents";
      const boundingRectangle = element.getBoundingClientRect();
      const clipsContent =
        style.overflow !== "visible" || style.clip !== "auto" || style.clipPath !== "none";
      const isScreenReaderOnly =
        hasOwnBox &&
        (element.textContent?.trim() ?? "").length > 0 &&
        element.checkVisibility() &&
        ((boundingRectangle.width <= 1 && boundingRectangle.height <= 1 && clipsContent) ||
          boundingRectangle.right + window.scrollX <= 0 ||
          boundingRectangle.bottom + window.scrollY <= 0);

      if (isScreenReaderOnly) {
        element.setAttribute(attributeName, "");
      } else {
        markScreenReaderOnlyDescendants(element);
      }
    }
  };

  markScreenReaderOnlyDescendants(document.body);
}

export function extractCoverImageDeclaration(
  headHtml: string,
  sourcePageUrl: string,
): CoverImageDeclaration | undefined {
  const metadata = collectMetadata(parseFragment(headHtml));
  const openGraphImage = selectFirstOpenGraphImage(metadata);
  const candidates = [
    ...OPEN_GRAPH_IMAGE_URL_PROPERTIES.map((property) => ({
      declaredUrl: findMetadataContent(openGraphImage, property),
      alternativeText: findMetadataContent(openGraphImage, "og:image:alt"),
    })),
    ...TWITTER_IMAGE_URL_PROPERTIES.map((property) => ({
      declaredUrl: findMetadataContent(metadata, property),
      alternativeText: findMetadataContent(metadata, "twitter:image:alt"),
    })),
  ];

  for (const { declaredUrl, alternativeText } of candidates) {
    const url = resolveCoverImageUrl(declaredUrl, sourcePageUrl);

    if (url !== undefined) {
      return {
        url,
        ...(alternativeText === undefined
          ? {}
          : { alternativeText: alternativeText.slice(0, MAX_COVER_IMAGE_ALTERNATIVE_TEXT_LENGTH) }),
      };
    }
  }

  return undefined;
}

function extractDeclaredLanguage(
  htmlLang: string | null,
  headHtml: string,
): DeclaredLanguage | undefined {
  const ogLocale = findMetadataContent(collectMetadata(parseFragment(headHtml)), "og:locale");
  const declaredLanguage: DeclaredLanguage = {
    ...(htmlLang === null || htmlLang.trim().length === 0 ? {} : { htmlLang }),
    ...(ogLocale === undefined ? {} : { ogLocale }),
  };

  return Object.keys(declaredLanguage).length > 0 ? declaredLanguage : undefined;
}

function resolveCoverImageUrl(
  declaredUrl: string | undefined,
  sourcePageUrl: string,
): string | undefined {
  if (declaredUrl === undefined || !URL.canParse(declaredUrl, sourcePageUrl)) {
    return undefined;
  }

  const url = new URL(declaredUrl, sourcePageUrl);

  return (url.protocol === "http:" || url.protocol === "https:") &&
    url.href.length <= MAX_COVER_IMAGE_URL_LENGTH
    ? url.href
    : undefined;
}

function selectFirstOpenGraphImage(metadata: readonly Metadata[]): Metadata[] {
  const firstIndex = metadata.findIndex(isOpenGraphImageProperty);

  if (firstIndex === -1) {
    return [];
  }

  const imageIndex = metadata.findIndex(
    (item, index) => index >= firstIndex && item.property === "og:image",
  );
  const nextImageIndex =
    imageIndex === -1
      ? -1
      : metadata.findIndex((item, index) => index > imageIndex && item.property === "og:image");

  return metadata.slice(firstIndex, nextImageIndex === -1 ? undefined : nextImageIndex);
}

function isOpenGraphImageProperty(item: Metadata): boolean {
  return item.property === "og:image" || item.property.startsWith("og:image:");
}

function findMetadataContent(metadata: readonly Metadata[], property: string): string | undefined {
  return metadata.find((item) => item.property === property)?.content;
}

function cutBeforeAndIncluding(element: HtmlElement): void {
  let node: DefaultTreeAdapterMap["childNode"] = element;
  let parentNode = element.parentNode;
  let shouldRemoveNode = true;

  while (parentNode) {
    const nodeIndex = parentNode.childNodes.indexOf(node);
    parentNode.childNodes.splice(0, shouldRemoveNode ? nodeIndex + 1 : nodeIndex);

    if (!("tagName" in parentNode)) {
      break;
    }

    node = parentNode;
    parentNode = parentNode.parentNode;
    shouldRemoveNode = false;
  }
}

function removeScreenReaderOnlyContent(parentNode: HtmlParentNode): void {
  const screenReaderOnlyElements = findAllElements(
    parentNode,
    (element) => getAttribute(element, SCREEN_READER_ONLY_CONTENT_ATTRIBUTE) !== undefined,
  );

  for (const element of screenReaderOnlyElements) {
    element.parentNode?.childNodes.splice(element.parentNode.childNodes.indexOf(element), 1);
  }
}

function removeAttribute(parentNode: HtmlParentNode, attributeName: string): void {
  for (const element of findAllElements(parentNode, () => true)) {
    element.attrs = element.attrs.filter((attribute) => attribute.name !== attributeName);
  }
}

function selectBetterSourceMaterial(sourceMaterials: readonly SourceMaterial[]): SourceMaterial {
  const [firstSourceMaterial, ...remainingSourceMaterials] = sourceMaterials;

  if (!firstSourceMaterial) {
    throw new CupError("Expected at least one prepared source material candidate");
  }

  return remainingSourceMaterials.reduce(
    (bestSourceMaterial, sourceMaterial) =>
      getSourceMaterialTextLength(sourceMaterial) >
      getSourceMaterialTextLength(bestSourceMaterial) * BETTER_SOURCE_MATERIAL_TEXT_FACTOR
        ? sourceMaterial
        : bestSourceMaterial,
    firstSourceMaterial,
  );
}

function getSourceMaterialTextLength(sourceMaterial: SourceMaterial): number {
  const documentFragment = parseFragment(sourceMaterial.html);
  const contentRoot =
    findFirstElement(documentFragment, (element) => element.tagName === "article") ??
    documentFragment;
  const narrationText = extractNarrationText(contentRoot);

  return normalizeWhitespace(narrationText || extractNodeText(contentRoot)).length;
}

function extractNarrationText(parentNode: HtmlParentNode): string {
  return parentNode.childNodes
    .map((childNode) => {
      if (!("tagName" in childNode)) {
        return "";
      }

      return NARRATION_TEXT_ELEMENT_TAG_NAMES.has(childNode.tagName)
        ? extractNodeText(childNode)
        : extractNarrationText(childNode);
    })
    .join("");
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function cleanAudiobookSourceMaterialHtml(html: string): string {
  const documentFragment = parseFragment(html);

  removeIrrelevantAndEmptyElements(documentFragment);

  return serialize(documentFragment);
}

export function assertPublicSourceUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CupError("Source URL must use HTTP or HTTPS");
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1")
    .replace(/\.$/u, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname)
  ) {
    throw new CupError("Source destination is not public");
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) {
    return true;
  }
  const address = octets.reduce((result, octet) => result * 256 + octet, 0);
  return NON_PUBLIC_IPV4_RANGES.some(
    ([rangeStart, rangeEnd]) => address >= rangeStart && address <= rangeEnd,
  );
}

function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) {
    return false;
  }
  const normalized = hostname.toLowerCase();
  if (normalized === "::" || normalized === "::1") {
    return true;
  }
  if (/^(?:fc|fd)/u.test(normalized) || /^fe[89ab]/u.test(normalized)) {
    return true;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1];
  return mapped !== undefined && isPrivateIpv4(mapped);
}

function removeIrrelevantAndEmptyElements(parentNode: HtmlParentNode): void {
  for (let childIndex = parentNode.childNodes.length - 1; childIndex >= 0; childIndex -= 1) {
    const childNode = parentNode.childNodes[childIndex];

    if (childNode?.nodeName === "#comment") {
      parentNode.childNodes.splice(childIndex, 1);
      continue;
    }

    if (!childNode || !("tagName" in childNode)) {
      continue;
    }

    const role = getAttribute(childNode, "role");
    if (
      IRRELEVANT_ELEMENT_TAG_NAMES.has(childNode.tagName) ||
      role === "navigation" ||
      role === "search"
    ) {
      parentNode.childNodes.splice(childIndex, 1);
      continue;
    }

    const content = isTemplateElement(childNode) ? childNode.content : childNode;
    removeIrrelevantAndEmptyElements(content);

    if (
      MEANINGFUL_EMPTY_ELEMENT_TAG_NAMES.has(childNode.tagName) ||
      content.childNodes.some(
        (grandchildNode) =>
          "tagName" in grandchildNode ||
          (grandchildNode.nodeName === "#text" && Boolean(grandchildNode.value.trim())),
      )
    ) {
      continue;
    }

    parentNode.childNodes.splice(childIndex, 1);
  }
}
