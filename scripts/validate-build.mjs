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

await access(resolve(dist, "index.html"));
console.log(`Validated dist: manifest, ${manifest.code}, ${manifest.icon}, index.html, and CORS headers.`);
