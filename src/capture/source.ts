import { utf8ByteLength } from "../shared/validation";
import { inlineWebFonts } from "./fonts";

export interface ResolvedSource {
  html: string;
  baseUrl?: string;
  sourceUrl?: string;
}

type AssetMode = "html" | "svg" | "css" | "font" | "asset";
export type { AssetMode };

const FETCH_SERVICE_PATH = "/api/fetch-html";
const LOCAL_PROXY_PATH = "/__html_to_penpot/fetch";
const MAX_INLINE_SVG_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_STYLESHEETS = 8;
const MAX_INLINE_STYLESHEET_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_STYLES_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_INLINE_IMAGE_ASSETS = 16;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

/** Distinguishes "origin answered" (no fallback warranted) from CORS/network failure. */
class UpstreamStatusError extends Error {}

/**
 * Origin of the hosted fetch service, fixed at build time so the plugin never
 * assumes its own deployment origin. Empty when the service is not part of
 * this build; URL imports then rely on browser CORS alone.
 */
function fetchServiceOrigin(): string | undefined {
  const origin = import.meta.env?.VITE_FETCH_PROXY_ORIGIN;
  if (typeof origin !== "string" || !origin.trim()) return undefined;
  return origin.trim().replace(/\/+$/, "");
}

function isLocalDevelopmentHost(): boolean {
  const hostname = typeof globalThis.location === "object" ? globalThis.location.hostname : undefined;
  return !!hostname && ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"].includes(hostname);
}

function proxyUrlFor(target: string, mode: AssetMode): string | undefined {
  const params = `mode=${mode}&url=${encodeURIComponent(target)}`;
  const serviceOrigin = fetchServiceOrigin();
  if (serviceOrigin) return `${serviceOrigin}${FETCH_SERVICE_PATH}?${params}`;
  // Local development keeps using the Vite preview middleware.
  const origin = typeof globalThis.location === "object" ? globalThis.location.origin : "";
  if (isLocalDevelopmentHost() && origin && origin !== "null") {
    return `${origin}${LOCAL_PROXY_PATH}?${params}`;
  }
  return undefined;
}

/**
 * Origin-plus-path of the constrained asset proxy, without query parameters.
 * The trusted-script network shim rewrites a page's own same-origin requests
 * here. Undefined when no proxy is configured for this build.
 */
export function assetProxyBase(): string | undefined {
  const serviceOrigin = fetchServiceOrigin();
  if (serviceOrigin) return `${serviceOrigin}${FETCH_SERVICE_PATH}`;
  const origin = typeof globalThis.location === "object" ? globalThis.location.origin : "";
  if (isLocalDevelopmentHost() && origin && origin !== "null") return `${origin}${LOCAL_PROXY_PATH}`;
  return undefined;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : "the browser blocked the request";
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function extensionOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path.slice(path.lastIndexOf(".")).toLowerCase();
  } catch {
    return "";
  }
}

function assetMimeType(response: Response, url: string): string | undefined {
  const declared = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (declared?.startsWith("image/")) return declared;
  return IMAGE_MIME_BY_EXTENSION[extensionOf(url)];
}

async function imageDataUrl(url: string): Promise<{ dataUrl: string; bytes: number } | undefined> {
  const response = await fetchDocument(url, "asset");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > MAX_INLINE_IMAGE_BYTES) return undefined;
  const mimeType = assetMimeType(response, url);
  if (!mimeType) return undefined;
  return { dataUrl: `data:${mimeType};base64,${base64Of(bytes)}`, bytes: bytes.byteLength };
}

function absoluteAssetUrl(value: string, baseUrl: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("blob:") || trimmed.startsWith("#")) return undefined;
  try {
    const target = new URL(trimmed, baseUrl);
    return target.protocol === "http:" || target.protocol === "https:" ? target.href : undefined;
  } catch {
    return undefined;
  }
}

const INLINE_STYLE_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const FONT_FACE_PATTERN = /@font-face\s*\{[^{}]*\}/gi;

const STYLESHEET_URL_PATTERN = /["']([^"']+\.css(?:[?#][^"']*)?)["']/gi;

interface StylesheetCandidate {
  url: string;
  media?: string;
  link?: HTMLLinkElement;
}

function rebaseCssUrls(css: string, baseUrl: string): string {
  return css.replace(INLINE_STYLE_URL_PATTERN, (match, _quote: string, source: string) => {
    const target = absoluteAssetUrl(source, baseUrl);
    return target ? `url("${target}")` : match;
  });
}

/**
 * Find stylesheets declared in markup and in small loader scripts. Some older
 * sites (including Dance/NYC) inject their only stylesheet from JavaScript;
 * scripts are intentionally disabled by default, so those styles need to be
 * copied into the capture document before it is rendered.
 */
function stylesheetCandidates(document: Document, baseUrl: string): StylesheetCandidate[] {
  const candidates = new Map<string, StylesheetCandidate>();
  for (const link of document.querySelectorAll<HTMLLinkElement>("link[rel~='stylesheet'][href]")) {
    const source = link.getAttribute("href");
    const url = source && absoluteAssetUrl(source, baseUrl);
    if (!url) continue;
    candidates.set(url, { url, media: link.getAttribute("media") || undefined, link });
  }
  for (const script of document.querySelectorAll("script")) {
    for (const match of (script.textContent || "").matchAll(STYLESHEET_URL_PATTERN)) {
      const url = absoluteAssetUrl(match[1], baseUrl);
      if (url && !candidates.has(url)) candidates.set(url, { url });
    }
  }
  return [...candidates.values()];
}

/** Inline external CSS so computed styles survive the opaque capture sandbox. */
async function inlineStylesheets(html: string, baseUrl: string | undefined): Promise<string> {
  if (!baseUrl || typeof DOMParser === "undefined") return html;
  const document = new DOMParser().parseFromString(html, "text/html");
  const candidates = stylesheetCandidates(document, baseUrl).slice(0, MAX_INLINE_STYLESHEETS);
  if (!candidates.length) return html;

  const head = document.head || document.documentElement;
  let totalBytes = 0;
  let changed = false;
  for (const candidate of candidates) {
    if (totalBytes >= MAX_INLINE_STYLES_TOTAL_BYTES) break;
    try {
      const response = await fetchDocument(candidate.url, "css");
      const css = await response.text();
      const bytes = utf8ByteLength(css);
      if (!css.trim() || bytes > MAX_INLINE_STYLESHEET_BYTES || totalBytes + bytes > MAX_INLINE_STYLES_TOTAL_BYTES) continue;
      const style = document.createElement("style");
      style.setAttribute("data-html-to-penpot-stylesheet", candidate.url);
      if (candidate.media) style.setAttribute("media", candidate.media);
      style.textContent = rebaseCssUrls(css, candidate.url);
      head.append(style);
      candidate.link?.remove();
      totalBytes += bytes;
      changed = true;
    } catch {
      // Keep an unavailable stylesheet in place; the sandbox may still load it.
    }
  }
  return changed ? "<!doctype html>\n" + document.documentElement.outerHTML : html;
}

function srcsetUrls(value: string): string[] {
  return value.split(",").map((candidate) => candidate.trim().split(/\s+/, 1)[0]).filter(Boolean);
}

function likelyImageUrl(url: string): boolean {
  return Boolean(IMAGE_MIME_BY_EXTENSION[extensionOf(url)]);
}

function rewriteSrcset(value: string, baseUrl: string, dataUrls: Map<string, string>): string {
  return value.split(",").map((candidate) => {
    const parts = candidate.trim().split(/\s+/);
    const source = parts.shift();
    if (!source) return candidate;
    const target = absoluteAssetUrl(source, baseUrl);
    const dataUrl = target && dataUrls.get(target);
    return dataUrl ? [dataUrl, ...parts].join(" ") : candidate;
  }).join(", ");
}

/** Inline ordinary image assets so Penpot receives bytes instead of fetching remote URLs server-side. */
async function inlineImageAssets(html: string, baseUrl: string | undefined): Promise<string> {
  if (!baseUrl || typeof DOMParser === "undefined") return html;
  const document = new DOMParser().parseFromString(html, "text/html");
  const targets = new Set<string>();
  const images = [...document.querySelectorAll("img[src]")];
  for (const image of images) {
    const source = image.getAttribute("src");
    const target = source && absoluteAssetUrl(source, baseUrl);
    // SVG <img> elements are handled by the vector pass below. Keeping them
    // out of the raster budget ensures ordinary header/hero images win even
    // on pages with many social icons.
    if (target && !isSvgUrl(target)) targets.add(target);
  }
  for (const element of document.querySelectorAll("img[srcset], source[srcset]")) {
    for (const source of srcsetUrls(element.getAttribute("srcset") || "")) {
      const target = absoluteAssetUrl(source, baseUrl);
      if (target && !isSvgUrl(target)) targets.add(target);
    }
  }
  for (const element of document.querySelectorAll("[style]")) {
    const style = element.getAttribute("style") || "";
    for (const match of style.matchAll(INLINE_STYLE_URL_PATTERN)) {
      const target = absoluteAssetUrl(match[2], baseUrl);
      if (target && likelyImageUrl(target)) targets.add(target);
    }
  }
  for (const style of document.querySelectorAll("style")) {
    // Font sources are presentation data and are handled by inlineWebFonts;
    // treating legacy SVG fonts as page images would consume the image budget.
    const css = (style.textContent || "").replace(FONT_FACE_PATTERN, "");
    for (const match of css.matchAll(INLINE_STYLE_URL_PATTERN)) {
      const target = absoluteAssetUrl(match[2], baseUrl);
      if (target && likelyImageUrl(target)) targets.add(target);
    }
  }

  const dataUrls = new Map<string, string>();
  let totalBytes = 0;
  for (const target of [...targets].slice(0, MAX_INLINE_IMAGE_ASSETS)) {
    if (totalBytes >= MAX_INLINE_IMAGE_TOTAL_BYTES) break;
    try {
      const result = await imageDataUrl(target);
      if (!result || totalBytes + result.bytes > MAX_INLINE_IMAGE_TOTAL_BYTES) continue;
      dataUrls.set(target, result.dataUrl);
      totalBytes += result.bytes;
    } catch {
      // A blocked or unsupported image remains a best-effort remote asset.
    }
  }
  if (!dataUrls.size) return html;

  for (const image of images) {
    const source = image.getAttribute("src");
    const target = source && absoluteAssetUrl(source, baseUrl);
    const dataUrl = target && dataUrls.get(target);
    if (dataUrl) image.setAttribute("src", dataUrl);
  }
  for (const element of document.querySelectorAll("img[srcset], source[srcset]")) {
    const source = element.getAttribute("srcset") || "";
    const rewritten = rewriteSrcset(source, baseUrl, dataUrls);
    if (rewritten !== source) element.setAttribute("srcset", rewritten);
  }
  for (const element of document.querySelectorAll("[style]")) {
    const style = element.getAttribute("style") || "";
    const rewritten = style.replace(INLINE_STYLE_URL_PATTERN, (match, _quote: string, source: string) => {
      const target = absoluteAssetUrl(source, baseUrl);
      const dataUrl = target && dataUrls.get(target);
      return dataUrl ? `url("${dataUrl}")` : match;
    });
    if (rewritten !== style) element.setAttribute("style", rewritten);
  }
  for (const element of document.querySelectorAll("style")) {
    const style = element.textContent || "";
    const rewritten = style.replace(INLINE_STYLE_URL_PATTERN, (match, _quote: string, source: string) => {
      const target = absoluteAssetUrl(source, baseUrl);
      const dataUrl = target && dataUrls.get(target);
      return dataUrl ? `url("${dataUrl}")` : match;
    });
    if (rewritten !== style) element.textContent = rewritten;
  }
  return "<!doctype html>\n" + document.documentElement.outerHTML;
}

/** Turn a normalised service rejection into an actionable plugin error. */
async function describeProxyRejection(url: string, response: Response): Promise<string> {
  let reason = "";
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === "string") reason = payload.error;
  } catch {
    // Non-JSON bodies carry no usable reason.
  }
  if (!reason) reason = `the import service rejected the request (HTTP ${response.status}).`;
  return `Unable to load ${url}: ${reason.endsWith(".") ? reason : `${reason}.`}`;
}

/**
 * Fetch a document directly first; when the browser reports a CORS or network
 * failure, retry through the constrained fetch service. An answer from the
 * origin itself (any HTTP status) is authoritative and never retried.
 */
export async function fetchDocument(url: string, mode: AssetMode): Promise<Response> {
  try {
    const direct = await fetch(url, { credentials: "omit", redirect: "follow" });
    if (direct.ok) return direct;
    throw new UpstreamStatusError(`Unable to load ${url}: the server returned HTTP ${direct.status}.`);
  } catch (error) {
    if (error instanceof UpstreamStatusError) throw error;
    return await fetchThroughProxy(url, mode, error);
  }
}

async function fetchThroughProxy(url: string, mode: AssetMode, directError: unknown): Promise<Response> {
  const proxyTarget = proxyUrlFor(url, mode);
  if (!proxyTarget) {
    throw new Error(
      `Unable to load ${url}. Paste the page HTML instead; direct URL loading requires browser CORS (${detailOf(directError)}) and no fetch service is configured.`
    );
  }
  let response: Response;
  try {
    response = await fetch(proxyTarget, { credentials: "omit" });
  } catch (proxyError) {
    throw new Error(
      `Unable to load ${url}. Direct loading was blocked by CORS (${detailOf(directError)}); the import service also failed (${detailOf(proxyError)}). Paste the page HTML instead.`
    );
  }
  if (!response.ok) throw new Error(await describeProxyRejection(url, response));
  return response;
}

function isSvgUrl(value: string): boolean {
  try {
    return new URL(value).pathname.toLowerCase().endsWith(".svg");
  } catch {
    return false;
  }
}

async function inlineSvgImages(html: string, baseUrl: string | undefined): Promise<string> {
  if (!baseUrl || typeof DOMParser === "undefined") return html;
  const document = new DOMParser().parseFromString(html, "text/html");
  const images = [...document.querySelectorAll("img[src]")];
  let changed = false;
  await Promise.all(images.map(async (image) => {
    const source = image.getAttribute("src");
    if (!source || source.startsWith("data:")) return;
    let target: URL;
    try { target = new URL(source, baseUrl); } catch { return; }
    if (!isSvgUrl(target.href)) return;
    let response: Response;
    try {
      response = await fetchDocument(target.href, "svg");
    } catch {
      return; // Assets are best-effort; the page still imports.
    }
    const contentLength = Number(response.headers.get("content-length") || "0");
    if (contentLength > MAX_INLINE_SVG_BYTES) return;
    const svg = await response.text();
    if (utf8ByteLength(svg) > MAX_INLINE_SVG_BYTES || !/<svg[\s>]/i.test(svg)) return;
    image.setAttribute("src", `data:image/svg+xml,${encodeURIComponent(svg)}`);
    changed = true;
  }));
  return changed ? "<!doctype html>\n" + document.documentElement.outerHTML : html;
}

/** Return a web URL only when the complete source value is a URL. */
export function sourceUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/\s/.test(trimmed)) return undefined;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the editor value into HTML. Pasted markup is returned unchanged;
 * a complete HTTP(S) URL is fetched by the browser first, with the hardened
 * fetch service taking over only when CORS or the network prevents it. The
 * final upstream URL (after redirects) becomes the asset base URL.
 */
export async function resolveSource(value: string, explicitBaseUrl?: string): Promise<ResolvedSource> {
  const url = sourceUrl(value);
  if (!url) {
    const styles = await inlineStylesheets(value, explicitBaseUrl);
    const images = await inlineImageAssets(styles, explicitBaseUrl);
    const fonts = await inlineWebFonts(images, explicitBaseUrl);
    const html = await inlineSvgImages(fonts, explicitBaseUrl);
    return { html, baseUrl: explicitBaseUrl || undefined };
  }

  const response = await fetchDocument(url, "html");
  const html = await response.text();
  if (!html.trim()) throw new Error(`Unable to load ${url}: the response did not contain HTML.`);
  const baseUrl = explicitBaseUrl || response.headers.get("X-HTML-Source-URL") || url;
  const styles = await inlineStylesheets(html, baseUrl);
  const images = await inlineImageAssets(styles, baseUrl);
  const fonts = await inlineWebFonts(images, baseUrl);

  return {
    html: await inlineSvgImages(fonts, baseUrl),
    baseUrl,
    sourceUrl: url
  };
}
