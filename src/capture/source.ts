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
const MAX_INLINE_IMAGE_ASSETS = 16;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
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
  if (!value || value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("#")) return undefined;
  try {
    const target = new URL(value, baseUrl);
    return target.protocol === "http:" || target.protocol === "https:" ? target.href : undefined;
  } catch {
    return undefined;
  }
}

const INLINE_STYLE_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** Inline ordinary image assets so Penpot receives bytes instead of fetching remote URLs server-side. */
async function inlineImageAssets(html: string, baseUrl: string | undefined): Promise<string> {
  if (!baseUrl || typeof DOMParser === "undefined") return html;
  const document = new DOMParser().parseFromString(html, "text/html");
  const targets = new Set<string>();
  const images = [...document.querySelectorAll("img[src]")];
  for (const image of images) {
    const source = image.getAttribute("src");
    const target = source && absoluteAssetUrl(source, baseUrl);
    if (target) targets.add(target);
  }
  for (const element of document.querySelectorAll("[style]")) {
    const style = element.getAttribute("style") || "";
    for (const match of style.matchAll(INLINE_STYLE_URL_PATTERN)) {
      const target = absoluteAssetUrl(match[2], baseUrl);
      if (target) targets.add(target);
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
  for (const element of document.querySelectorAll("[style]")) {
    const style = element.getAttribute("style") || "";
    const rewritten = style.replace(INLINE_STYLE_URL_PATTERN, (match, _quote: string, source: string) => {
      const target = absoluteAssetUrl(source, baseUrl);
      const dataUrl = target && dataUrls.get(target);
      return dataUrl ? `url("${dataUrl}")` : match;
    });
    if (rewritten !== style) element.setAttribute("style", rewritten);
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
    const html = await inlineImageAssets(await inlineWebFonts(await inlineSvgImages(value, explicitBaseUrl), explicitBaseUrl), explicitBaseUrl);
    return { html, baseUrl: explicitBaseUrl || undefined };
  }

  const response = await fetchDocument(url, "html");
  const html = await response.text();
  if (!html.trim()) throw new Error(`Unable to load ${url}: the response did not contain HTML.`);
  const baseUrl = explicitBaseUrl || response.headers.get("X-HTML-Source-URL") || url;

  return {
    html: await inlineImageAssets(await inlineWebFonts(await inlineSvgImages(html, baseUrl), baseUrl), baseUrl),
    baseUrl,
    sourceUrl: url
  };
}
