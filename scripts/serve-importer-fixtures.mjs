#!/usr/bin/env node
/** Serve deterministic importer fixtures with CORS for a live Penpot pass. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, resolve, sep } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "capture", "fixtures");
const port = Number(process.env.IMPORTER_FIXTURE_PORT || 4174);
const mimeTypes = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2" };

const server = createServer(async (request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || "/", "http://fixture.local").pathname);
  } catch {
    response.writeHead(400, { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    response.end("Malformed fixture URL");
    return;
  }
  const target = resolve(root, `.${pathname}`);
  const commonHeaders = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  if (pathname === "/favicon.ico") {
    response.writeHead(204, commonHeaders);
    response.end();
    return;
  }
  if (!(target.startsWith(`${root}${sep}`))) {
    response.writeHead(403, commonHeaders);
    response.end("Outside fixture root");
    return;
  }
  try {
    const bytes = await readFile(target);
    response.writeHead(200, { ...commonHeaders, "Content-Type": mimeTypes[extname(target).toLowerCase()] || "application/octet-stream" });
    response.end(bytes);
  } catch {
    // asset-failures.html intentionally uses this branch for one local URL.
    response.writeHead(404, { ...commonHeaders, "Content-Type": "text/plain; charset=utf-8" });
    response.end("Fixture asset intentionally absent");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Importer fixtures: http://127.0.0.1:${port}/background-images.html\n`);
});
