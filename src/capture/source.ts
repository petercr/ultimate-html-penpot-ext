import { utf8ByteLength } from "../shared/validation";

export interface ResolvedSource {
  html: string;
  baseUrl?: string;
  sourceUrl?: string;
}

const FETCH_PROXY_PATH = "/__html_to_penpot/fetch";
const MAX_INLINE_SVG_BYTES = 2 * 1024 * 1024;

function localFetchProxyUrl(target: string): string | undefined {
  const origin = typeof globalThis.location === "object" ? globalThis.location.origin : "";
  if (!origin || origin === "null") return undefined;
  return `${origin}${FETCH_PROXY_PATH}?url=${encodeURIComponent(target)}`;
}

function isSvgUrl(value: string): boolean {
  try {
    return new URL(value).pathname.toLowerCase().endsWith(".svg");
  } catch {
    return false;
  }
}

async function fetchAsset(url: string): Promise<Response | undefined> {
  try {
    const direct = await fetch(url, { credentials: "omit", redirect: "follow" });
    if (direct.ok) return direct;
  } catch {
    // The page host may not grant CORS; try the same local proxy used for the
    // source document when this is running from the development server.
  }
  const proxyUrl = localFetchProxyUrl(url);
  if (!proxyUrl) return undefined;
  try {
    const proxied = await fetch(proxyUrl, { credentials: "omit", redirect: "follow" });
    return proxied.ok ? proxied : undefined;
  } catch {
    return undefined;
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
    const response = await fetchAsset(target.href);
    if (!response) return;
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
 * a complete HTTP(S) URL is fetched so the browser can render the page itself.
 * The direct request is attempted first. If the target does not grant browser
 * CORS, the local development server proxy is used instead.
 */
export async function resolveSource(value: string, explicitBaseUrl?: string): Promise<ResolvedSource> {
  const url = sourceUrl(value);
  if (!url) return { html: await inlineSvgImages(value, explicitBaseUrl), baseUrl: explicitBaseUrl || undefined };

  let response: Response | undefined;
  let directError: unknown;
  try {
    response = await fetch(url, { credentials: "omit", redirect: "follow" });
  } catch (error) {
    directError = error;
  }

  if (!response) {
    const proxyUrl = localFetchProxyUrl(url);
    if (proxyUrl) {
      try {
        response = await fetch(proxyUrl, { credentials: "omit", redirect: "follow" });
      } catch (proxyError) {
        const directDetail = directError instanceof Error ? directError.message : "the browser blocked the request";
        const proxyDetail = proxyError instanceof Error ? proxyError.message : "the local proxy could not be reached";
        throw new Error(`Unable to load ${url}. Direct loading was blocked by CORS (${directDetail}); the local fetch proxy also failed (${proxyDetail}). Paste the page HTML instead.`);
      }
    } else {
      const detail = directError instanceof Error ? directError.message : "the browser blocked the request";
      throw new Error(`Unable to load ${url}. Paste the page HTML instead; direct URL loading requires browser CORS (${detail}).`);
    }
  }
  if (!response.ok) throw new Error(`Unable to load ${url}: the server returned HTTP ${response.status}.`);
  const html = await response.text();
  if (!html.trim()) throw new Error(`Unable to load ${url}: the response did not contain HTML.`);
  const baseUrl = explicitBaseUrl || response.headers.get("X-HTML-Source-URL") || url;

  return {
    html: await inlineSvgImages(html, baseUrl),
    baseUrl,
    sourceUrl: url
  };
}
