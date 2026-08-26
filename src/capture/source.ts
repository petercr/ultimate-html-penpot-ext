import { utf8ByteLength } from "../shared/validation";

export interface ResolvedSource {
  html: string;
  baseUrl?: string;
  sourceUrl?: string;
}

type AssetMode = "html" | "svg";

const FETCH_SERVICE_PATH = "/api/fetch-html";
const LOCAL_PROXY_PATH = "/__html_to_penpot/fetch";
const MAX_INLINE_SVG_BYTES = 2 * 1024 * 1024;

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

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : "the browser blocked the request";
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
async function fetchDocument(url: string, mode: AssetMode): Promise<Response> {
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
  if (!url) return { html: await inlineSvgImages(value, explicitBaseUrl), baseUrl: explicitBaseUrl || undefined };

  const response = await fetchDocument(url, "html");
  const html = await response.text();
  if (!html.trim()) throw new Error(`Unable to load ${url}: the response did not contain HTML.`);
  const baseUrl = explicitBaseUrl || response.headers.get("X-HTML-Source-URL") || url;

  return {
    html: await inlineSvgImages(html, baseUrl),
    baseUrl,
    sourceUrl: url
  };
}
