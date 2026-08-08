export interface ResolvedSource {
  html: string;
  baseUrl?: string;
  sourceUrl?: string;
}

const FETCH_PROXY_PATH = "/__html_to_penpot/fetch";

function localFetchProxyUrl(target: string): string | undefined {
  const origin = typeof globalThis.location === "object" ? globalThis.location.origin : "";
  if (!origin || origin === "null") return undefined;
  return `${origin}${FETCH_PROXY_PATH}?url=${encodeURIComponent(target)}`;
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
  if (!url) return { html: value, baseUrl: explicitBaseUrl || undefined };

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

  return {
    html,
    baseUrl: explicitBaseUrl || response.headers.get("X-HTML-Source-URL") || url,
    sourceUrl: url
  };
}
