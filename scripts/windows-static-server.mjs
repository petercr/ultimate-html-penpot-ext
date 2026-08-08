/**
 * Serves the built plugin from Windows itself. Use when a Windows Penpot
 * installation cannot reach a WSL-hosted development server.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const types = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
const fetchProxyPath = "/__html_to_penpot/fetch";
const maxHtmlBytes = 10 * 1024 * 1024;
const fetchTimeoutMs = 15_000;

async function proxyHtml(target, response) {
  let targetUrl;
  try {
    targetUrl = new URL(target);
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    response.writeHead(400).end("The url must be an http(s) URL.");
    return;
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" },
      redirect: "follow",
      signal: AbortSignal.timeout(fetchTimeoutMs)
    });
    if (!upstream.ok) {
      response.writeHead(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502).end(`The target server returned HTTP ${upstream.status}.`);
      return;
    }

    const html = await upstream.text();
    if (Buffer.byteLength(html, "utf8") > maxHtmlBytes) {
      response.writeHead(413).end("The target page is larger than the 10 MB limit.");
      return;
    }

    response.setHeader("Access-Control-Expose-Headers", "X-HTML-Source-URL");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-HTML-Source-URL", upstream.url || targetUrl.href);
    response.writeHead(200).end(html);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "the proxy request failed";
    response.writeHead(502).end(`Unable to fetch the target page: ${detail}`);
  }
}

createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (request.method === "OPTIONS") return response.writeHead(204).end();
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host}`);
  if (requestUrl.pathname === fetchProxyPath) {
    if (request.method !== "GET") return response.writeHead(405).end("Only GET is supported.");
    const target = requestUrl.searchParams.get("url");
    if (!target) return response.writeHead(400).end("Missing url query parameter.");
    return proxyHtml(target, response);
  }
  const pathname = decodeURIComponent(requestUrl.pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = normalize(join(dist, relative));
  if (!target.startsWith(dist)) return response.writeHead(403).end("Forbidden");
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, { "Content-Type": types[extname(target)] || "application/octet-stream", "Cache-Control": "no-cache" });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, host, () => console.log(`Ultimate HTML to Penpot: http://${host}:${port}/manifest.json`));
