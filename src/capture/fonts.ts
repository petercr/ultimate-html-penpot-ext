import { utf8ByteLength } from "../shared/validation";
import { fetchDocument } from "./source";

/** Fonts are inert presentation data; a small fleet per page is plenty. */
const MAX_FONT_URLS = 24;
const MAX_FONT_BYTES = 1.5 * 1024 * 1024;
const MAX_STYLESHEET_BYTES = 2 * 1024 * 1024;

const FONT_MIME_BY_EXTENSION: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf"
};

const FONT_FACE_PATTERN = /@font-face\s*\{[^{}]*\}/g;
const URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
/** Legacy formats browsers only try after the modern ones fail; dropping them keeps overrides small. */
const LEGACY_FONT_URL = /\.(?:eot|svg)(?:[?#]|$)/;

/** Every webfont URL referenced by @font-face rules in a stylesheet. */
function fontUrlsOf(css: string): string[] {
  const urls: string[] = [];
  for (const block of css.match(FONT_FACE_PATTERN) || []) {
    for (const segment of block.match(SOURCE_SEGMENT_PATTERN) || []) {
      for (const match of segment.matchAll(URL_PATTERN)) {
        const url = match[2].trim();
        if (!url || url.startsWith("data:") || url.startsWith("blob:") || /^local\(/i.test(url) || LEGACY_FONT_URL.test(url)) continue;
        urls.push(url);
      }
    }
  }
  return urls;
}

/** Segments of a src list that reference a font file, e.g. `url(x) format('woff2')`. */
const SOURCE_SEGMENT_PATTERN = /[^,()]*url\([^)]*\)\s*(?:format\([^)]*\)\s*)?[^,;]*/g;
const SRC_PROPERTY_PATTERN = /src\s*:\s*[^;}]*(;|$)/g;

/**
 * Re-point every fetchable url() in an @font-face rule at its inlined data
 * equivalent. Rules whose fonts could not be fetched are dropped whole: a
 * rule keeping the remote reference would still be CORS-blocked in the
 * sandbox and only re-trigger the failed load. Legacy EOT/SVG sources are
 * dropped rather than fetched — modern browsers never reach them, and their
 * bytes (SVG fonts in particular) can be large.
 */
function rebasedFontFaces(css: string, dataUrls: Map<string, string>): string[] {
  const rules: string[] = [];
  for (const block of css.match(FONT_FACE_PATTERN) || []) {
    const segments = block.match(SOURCE_SEGMENT_PATTERN) || [];
    const kept = segments.filter((segment) => ![...segment.matchAll(URL_PATTERN)].some((match) => LEGACY_FONT_URL.test(match[2].trim())));
    // Rules with only legacy sources have no modern fallback to rewrite.
    if (!kept.length) continue;
    const urls = kept.flatMap((segment) => [...segment.matchAll(URL_PATTERN)]).map((match) => match[2].trim()).filter((url) => !url.startsWith("data:") && !url.startsWith("blob:"));
    if (!urls.length || !urls.every((url) => dataUrls.has(url))) continue;
    const rewritten = kept.map((segment) => segment.replace(URL_PATTERN, (match, _quote: string, url: string) => dataUrls.has(url) ? `url("${dataUrls.get(url)}")` : match)).join(",");
    // Rebuild with every original src declaration replaced by the rewritten
    // one so descriptors keep their order-independent meaning.
    const opening = block.indexOf("{");
    const body = block.slice(opening + 1, block.lastIndexOf("}"));
    rules.push(`${block.slice(0, opening + 1)}${body.replace(SRC_PROPERTY_PATTERN, "")}src:${rewritten};}`);
  }
  return rules;
}

function extensionOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path.slice(path.lastIndexOf(".")).toLowerCase();
  } catch {
    return "";
  }
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function fontDataUrl(url: string): Promise<string | undefined> {
  const response = await fetchDocument(url, "font");
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (!buffer.byteLength || buffer.byteLength > MAX_FONT_BYTES) return undefined;
  const declared = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const mimeType = declared && /^(font\/|application\/(font|x-font|vnd\.ms-fontobject|octet-stream))/.test(declared) && declared !== "application/octet-stream"
    ? declared
    : FONT_MIME_BY_EXTENSION[extensionOf(url)] || "application/octet-stream";
  return `data:${mimeType};base64,${base64Of(buffer)}`;
}

/**
 * Inline the page's webfonts as data: URLs appended in a trailing override
 * stylesheet. The capture sandbox is an opaque origin, and browsers always
 * fetch fonts in CORS mode, so @font-face fonts from hosts without
 * `Access-Control-Allow-Origin` silently fall back to system fonts and every
 * measured text box drifts from the real site. Fetching here (directly when
 * the host allows it, otherwise through the constrained import service) and
 * appending `data:`-sourced copies of the same @font-face rules restores the
 * site's real font metrics inside the sandbox. Existing markup and styles
 * are never modified; the original declarations keep working as a fallback.
 */
export async function inlineWebFonts(html: string, baseUrl?: string): Promise<string> {
  // Font rules may live in linked stylesheets rather than the markup itself,
  // so the cheap text check alone cannot rule the pass out.
  if (!baseUrl || typeof DOMParser === "undefined" || (!html.includes("@font-face") && !html.includes("<link"))) return html;

  const document = new DOMParser().parseFromString(html, "text/html");
  const stylesheets: string[] = [];
  for (const style of document.querySelectorAll("style")) stylesheets.push(style.textContent || "");

  await Promise.all([...document.querySelectorAll("link[rel~='stylesheet'][href]")].map(async (link) => {
    const href = link.getAttribute("href");
    if (!href) return;
    try {
      const target = new URL(href, baseUrl);
      if (target.protocol !== "https:" && target.protocol !== "http:") return;
      const response = await fetchDocument(target.href, "css");
      const css = await response.text();
      if (utf8ByteLength(css) <= MAX_STYLESHEET_BYTES) stylesheets.push(css);
    } catch {
      // Linked fonts stay remote when the stylesheet cannot be read; the
      // sandbox behaves exactly as it would have without this pass.
    }
  }));

  const urls = [...new Set(stylesheets.flatMap(fontUrlsOf))].slice(0, MAX_FONT_URLS);
  const dataUrls = new Map<string, string>();
  await Promise.all(urls.map(async (url) => {
    try {
      const absolute = new URL(url, baseUrl);
      if (absolute.protocol !== "https:" && absolute.protocol !== "http:") return;
      const dataUrl = await fontDataUrl(absolute.href);
      if (dataUrl) dataUrls.set(url, dataUrl);
    } catch {
      // A font the service cannot reach stays remote; capture falls back to
      // system fonts for that family only.
    }
  }));
  if (!dataUrls.size) return html;

  const rules = stylesheets.flatMap((css) => rebasedFontFaces(css, dataUrls));
  if (!rules.length) return html;

  const override = document.createElement("style");
  override.setAttribute("data-html-to-penpot-fonts", "");
  override.textContent = rules.join("\n");
  (document.head || document.documentElement).append(override);
  return "<!doctype html>\n" + document.documentElement.outerHTML;
}
