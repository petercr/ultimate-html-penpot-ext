import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const dist = resolve("dist");
const manifest = JSON.parse(await readFile(resolve(dist, "manifest.json"), "utf8"));

if (manifest.version !== 2) throw new Error("manifest.json must use schema version 2.");
if (manifest.permissions?.join(",") !== "content:write") throw new Error("Unexpected plugin permissions.");

for (const field of ["code", "icon"]) {
  const value = manifest[field];
  if (typeof value !== "string" || !value || value.includes(":") || value.startsWith("/") || value.includes("..")) {
    throw new Error(`manifest.json ${field} must be a safe relative path.`);
  }
  await access(resolve(dist, value));
}

const headers = await readFile(resolve(dist, "_headers"), "utf8");
if (!headers.includes("Access-Control-Allow-Origin: *")) throw new Error("Production CORS header is missing.");
const headerLines = headers.split("\n").map((line) => line.trim());
for (const path of ["/manifest.json", "/plugin.js"]) {
  if (!headerLines.includes(path)) throw new Error(`${path} cache rule is missing from _headers.`);
}
if (!headers.includes("max-age=31536000, immutable") || !headerLines.includes("/assets/*")) {
  throw new Error("Immutable asset caching is missing from _headers.");
}

const vercelConfig = JSON.parse(await readFile(resolve("vercel.json"), "utf8"));
const vercelHeaders = vercelConfig.headers;
if (!Array.isArray(vercelHeaders) || vercelHeaders.length === 0) throw new Error("vercel.json must define a headers array.");

function findVercelHeader(source, key) {
  const entry = vercelHeaders.find((rule) => rule?.source === source);
  return entry?.headers?.find((header) => header?.key === key)?.value;
}

// Static paths must stay CORS-open for Penpot; /api is excluded because the
// fetch service manages its own headers there.
const STATIC_SOURCE = "/((?!api/).*)";
if (findVercelHeader(STATIC_SOURCE, "Access-Control-Allow-Origin") !== "*") {
  throw new Error("vercel.json must send Access-Control-Allow-Origin: * for all static paths.");
}
if (findVercelHeader(STATIC_SOURCE, "X-Content-Type-Options") !== "nosniff") {
  throw new Error("vercel.json must send X-Content-Type-Options: nosniff.");
}

if (!vercelConfig.routes?.some((route) => route.src === "/api/fetch-html" && route.mitigate?.action === "challenge" && route.missing?.some((entry) => entry.key === "sec-fetch-site"))) {
  throw new Error("vercel.json must challenge /api/fetch-html when Sec-Fetch-Site is missing (Hobby edge filter).");
}
if (vercelConfig.functions?.["api/fetch-html.ts"]?.memory !== 512 || vercelConfig.functions?.["api/fetch-html.ts"]?.maxDuration !== 20) {
  throw new Error("vercel.json must bound api/fetch-html.ts at 512 MB / 20 s.");
}

await access(resolve(dist, "index.html"));
console.log(`Validated dist: manifest, ${manifest.code}, ${manifest.icon}, index.html, CORS headers, Vercel firewall, and resource bounds.`);
