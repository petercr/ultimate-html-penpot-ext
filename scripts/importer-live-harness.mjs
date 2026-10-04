#!/usr/bin/env node
// Temporarily replace ignored dist output for a signed-in, local host pass.
// Restore the normal plugin with npm run build after validation.
import { build } from "vite";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

function png(index) {
  const crc = (data) => {
    let value = 0xffffffff;
    for (const byte of data) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => { const type = Buffer.from(name); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(Buffer.concat([type, data]))); return Buffer.concat([size, type, data, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const data = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(Buffer.from([0,index * 19 % 256,index * 37 % 256,index * 53 % 256,255]))),chunk("IEND",Buffer.alloc(0))]);
  return `data:image/png;base64,${data.toString("base64")}`;
}

const result = await build({ configFile: false, logLevel: "error", define: { LIVE_IMAGES: JSON.stringify(Array.from({ length: 120 }, (_, index) => png(index))) }, build: { write: false, lib: { entry: resolve("scripts/lib/importer-live-harness.ts"), formats: ["iife"], name: "ImporterHostValidation" } } });
const output = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output);
const bundle = output.find((entry) => entry.type === "chunk")?.code;
if (!bundle) throw new Error("Empty validation bundle.");
await writeFile("dist/plugin.js", bundle);
await writeFile("dist/index.html", `<!doctype html><title>Importer host validation</title><p>Temporary local validation harness. Restore the plugin with npm run build.</p><pre id="result">Ready</pre><script>
addEventListener("message", event => {
  if (event.source !== parent) return;
  if (event.data?.phase5Command) parent.postMessage(event.data.phase5Command, "*");
  else { document.getElementById("result").textContent = JSON.stringify(event.data); parent.postMessage({ phase5Result: event.data }, "*"); }
});
</script>`);
process.stdout.write("Local validation harness built. Reopen the installed local plugin; run npm run build to restore it.\n");
