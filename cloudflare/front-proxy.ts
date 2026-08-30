type FrontEnv = Env & {
  // Secrets are intentionally absent from wrangler.jsonc and therefore from
  // the generated binding declaration. Keep the secret requirement explicit
  // at the handler boundary without duplicating the whole Env interface.
  FETCH_FRONT_SHARED_SECRET: string;
};

const SERVICE_PATH = "/api/fetch-html";
const ALLOWED_METHODS = "GET, OPTIONS";

function corsHeaders(origin: string): Headers {
  return new Headers({
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "X-HTML-Source-URL",
    "Access-Control-Max-Age": "600",
    Vary: "Origin"
  });
}

function copyHeaders(from: Headers, to: Headers): void {
  from.forEach((value, key) => to.set(key, value));
}

function jsonError(message: string, status: number, origin?: string): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  if (origin) {
    copyHeaders(corsHeaders(origin), headers);
  }
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function allowedOrigin(value: string | null): string | undefined {
  if (!value) return undefined;
  // Penpot plugin panels run in an opaque sandbox. Browsers serialize that
  // origin as the literal string `null`; it is safe to reflect this exact
  // value because the request still has to carry accepted Fetch Metadata and
  // the Worker rate limit plus Vercel front secret remain in force.
  if (value === "null") return "null";
  try {
    const origin = new URL(value);
    if (origin.protocol !== "https:") return undefined;
    if (origin.hostname === "ultimate-html-penpot-ext.vercel.app") return origin.origin;
    if (/^ultimate-html-penpot(?:-[a-z0-9]+)?-peter-cruckshanks-projects\.vercel\.app$/.test(origin.hostname)) {
      return origin.origin;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function hasBrowserMetadata(request: Request, origin: string | undefined): boolean {
  const site = (request.headers.get("Sec-Fetch-Site") || "").toLowerCase();
  return !!origin && ["cross-site", "same-origin", "same-site", "none"].includes(site);
}

export default {
  async fetch(request: Request, env: FrontEnv): Promise<Response> {
    const incoming = new URL(request.url);
    if (incoming.pathname !== SERVICE_PATH) return new Response("Not found.", { status: 404 });

    const origin = allowedOrigin(request.headers.get("Origin"));
    if (request.method === "OPTIONS") {
      return origin
        ? new Response(null, { status: 204, headers: corsHeaders(origin) })
        : jsonError("The import service is only available to the plugin.", 403);
    }
    if (request.method !== "GET") {
      return jsonError("Only GET requests are supported.", 405, origin);
    }
    if (!env.VERCEL_ORIGIN || !env.FETCH_FRONT_SHARED_SECRET) {
      return jsonError("The import service is not configured.", 503, origin);
    }
    if (!hasBrowserMetadata(request, origin)) {
      return jsonError("The import service is only available to the plugin.", 403);
    }

    const address = clientIp(request);
    const allowed = await env.FETCH_IP_LIMITER.limit({ key: `fetch-html:${address}` });
    if (!allowed.success) {
      const response = jsonError("Too many requests. Try again in a minute.", 429, origin);
      response.headers.set("Retry-After", "60");
      return response;
    }

    const upstream = new URL(SERVICE_PATH, env.VERCEL_ORIGIN);
    upstream.search = incoming.search;
    let response: Response;
    try {
      response = await fetch(upstream, {
        headers: {
          Accept: "application/json",
          "Sec-Fetch-Site": "same-origin",
          "X-Fetch-Client-IP": address,
          "X-Fetch-Front-Secret": env.FETCH_FRONT_SHARED_SECRET
        },
        method: "GET",
        redirect: "manual"
      });
    } catch {
      return jsonError("The import service could not be reached.", 502, origin);
    }

    if (response.status >= 300 && response.status < 400) {
      return jsonError("The import service returned an unexpected redirect.", 502, origin);
    }

    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": response.headers.get("Content-Type") || "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    });
    if (origin) {
      copyHeaders(corsHeaders(origin), headers);
    }
    const finalUrl = response.headers.get("X-HTML-Source-URL");
    if (finalUrl) headers.set("X-HTML-Source-URL", finalUrl);
    return new Response(response.body, { status: response.status, headers });
  }
} satisfies ExportedHandler<FrontEnv>;
