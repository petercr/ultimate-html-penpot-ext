import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const FETCH_PROXY_PATH = "/__html_to_penpot/fetch";
const MAX_HTML_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

function htmlFetchProxy() {
  return {
    name: "html-to-penpot-fetch-proxy",
    configurePreviewServer(server: { middlewares: { use: (handler: (request: any, response: any, next: () => void) => void) => void } }) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url === undefined || !request.url.startsWith(FETCH_PROXY_PATH)) {
          next();
          return;
        }

        if (request.method === "OPTIONS") {
          response.statusCode = 204;
          response.setHeader("Access-Control-Allow-Origin", "*");
          response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
          response.end();
          return;
        }
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.end("Only GET is supported.");
          return;
        }

        const target = new URL(request.url, "http://localhost").searchParams.get("url");
        if (!target) {
          response.statusCode = 400;
          response.end("Missing url query parameter.");
          return;
        }

        let targetUrl: URL;
        try {
          targetUrl = new URL(target);
          if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") throw new Error("unsupported protocol");
        } catch {
          response.statusCode = 400;
          response.end("The url must be an http(s) URL.");
          return;
        }

        try {
          const upstream = await fetch(targetUrl, {
            headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" },
            redirect: "follow",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
          });
          if (!upstream.ok) {
            response.statusCode = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
            response.setHeader("Access-Control-Allow-Origin", "*");
            response.end(`The target server returned HTTP ${upstream.status}.`);
            return;
          }

          const html = await upstream.text();
          if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
            response.statusCode = 413;
            response.setHeader("Access-Control-Allow-Origin", "*");
            response.end("The target page is larger than the 10 MB limit.");
            return;
          }

          response.statusCode = 200;
          response.setHeader("Access-Control-Allow-Origin", "*");
          response.setHeader("Access-Control-Expose-Headers", "X-HTML-Source-URL");
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("X-HTML-Source-URL", upstream.url || targetUrl.href);
          response.end(html);
        } catch (error) {
          response.statusCode = 502;
          response.setHeader("Access-Control-Allow-Origin", "*");
          const detail = error instanceof Error ? error.message : "the proxy request failed";
          response.end(`Unable to fetch the target page: ${detail}`);
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), htmlFetchProxy()],
  preview: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
    cors: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "index.html"
    }
  },
  test: {
    environment: "jsdom"
  }
});
