#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, platform, arch, cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "vite";
import { CdpPipe, closeChrome } from "./lib/chrome.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2];
const mode = process.argv[3]?.replace(/^--/, "") || "capture";
if (!output || process.argv.length > 4 || !["capture", "assets", "single-board"].includes(mode)) throw new Error("Usage: npm run benchmark:importer -- <output.json> [--assets|--single-board]");
const cases = mode === "capture" ? [{ name: "small", cards: 12 }, { name: "medium", cards: 80 }, { name: "large", cards: 240 }]
  : (mode === "assets" ? [12, 48, 120] : [1000, 5000, 20000]).map((size) => ({ name: String(size), size }));
const repetitions = 3;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sourceFiles = ["src/capture/source.ts", "src/capture/fonts.ts", "src/capture/sandbox.ts", "src/capture/prepareDocument.ts", "src/capture/extractor.ts", "src/importer/penpot.ts", "src/importer/assets.ts", "src/importer/persistence.ts", "src/importer/scheduler.ts", "src/shared/contracts.ts", "src/shared/validation.ts", "src/shared/performance.ts", "scripts/importer-benchmark.mjs", "scripts/lib/importer-benchmark-harness.ts", "scripts/lib/importer-workloads.ts", "scripts/lib/chrome.mjs"];
const inputHashes = () => Promise.all(sourceFiles.map(async (path) => ({ path, sha256: sha256(await readFile(join(root, path))) })));

function fixture(cards) {
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  return `<!doctype html><html><head><style>
    @font-face{font-family:Fixture;src:url(./DejaVuSans.ttf)}
    *{box-sizing:border-box}body{margin:0;padding:16px;font:14px/1.3 Fixture,sans-serif;background:#f5f5f5}
    main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
    article{height:128px;padding:8px;border:1px solid #ddd;background:white;overflow:hidden}
    h2{margin:0;font-size:16px}p{margin:4px 0}small{white-space:nowrap}img{float:right;width:16px;height:16px}
    @media(max-width:900px){main{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:500px){main{grid-template-columns:1fr}}
    </style></head><body><main>${Array.from({ length: cards }, (_, index) => `<article id="card-${index}"><img src="${image}" alt=""><h2>Card ${index} — café</h2><p>Wrapped text with Unicode: 👩🏽‍💻, é, 日本語 and nonbreaking&nbsp;spaces. This sentence preserves the browser’s measured line boundaries.</p><small>One short line ${index}</small></article>`).join("")}</main></body></html>`;
}

async function run() {
  let server, chrome, cdp, profile;
  try {
    const inputs = await inputHashes();
    const result = await build({ configFile: false, logLevel: "error", build: { write: false, lib: { entry: join(root, "scripts/lib/importer-benchmark-harness.ts"), formats: ["es"], fileName: "harness" }, minify: false } });
    const chunks = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output);
    const bundle = chunks.find((entry) => entry.type === "chunk")?.code;
    if (!bundle) throw new Error("Benchmark bundle was empty.");
    const font = await readFile(join(root, "src/capture/fixtures/assets/DejaVuSans.ttf"));
    server = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Cache-Control", "no-store");
      if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><script type="module">import {runBenchmark,runWorkload} from "/harness.js";window.runBenchmark=runBenchmark;window.runWorkload=runWorkload;</script>'); }
      else if (request.url === "/harness.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle); }
      else if (request.url === "/DejaVuSans.ttf") { response.setHeader("Content-Type", "font/ttf"); response.end(font); }
      else if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); }
      else { response.writeHead(404); response.end("Not found"); }
    });
    await new Promise((resolveServer, rejectServer) => { server.once("error", rejectServer); server.listen(0, "127.0.0.1", resolveServer); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    profile = await mkdtemp(join(tmpdir(), "importer-benchmark-"));
    chrome = spawn("google-chrome", ["--headless=new", "--disable-gpu", "--disable-background-networking", "--disable-component-update", "--no-first-run", "--remote-debugging-pipe", `--user-data-dir=${profile}`], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    cdp = new CdpPipe(chrome.stdio[3], chrome.stdio[4], chrome, 60_000);
    const browser = await cdp.send("Browser.getVersion");
    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }] }, sessionId);
    const externalRequests = new Set();
    cdp.on("Fetch.requestPaused", (event) => {
      if (event.sessionId !== sessionId) return;
      const allowed = event.params.request.url.startsWith(`${origin}/`);
      if (!allowed) externalRequests.add(event.params.request.url);
      void cdp.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", { requestId: event.params.requestId, ...(!allowed ? { errorReason: "AccessDenied" } : {}) }, sessionId).catch(() => undefined);
    });
    await cdp.send("Page.navigate", { url: origin }, sessionId);
    await cdp.send("Runtime.evaluate", { expression: 'new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error("Harness did not load")),10000);const ready=()=>{if(window.runBenchmark){clearTimeout(timeout);resolve(true)}else setTimeout(ready,20)};ready()})', awaitPromise: true }, sessionId);
    const samples = [];
    // Warm font loading, V8, and the actual capture/import paths before timed runs.
    await evaluate(mode === "capture" ? fixture(3) : mode === "assets" ? 3 : 100);
    for (const entry of cases) {
      const html = mode === "capture" ? fixture(entry.cards) : entry.size;
      for (let iteration = 1; iteration <= repetitions; iteration += 1) {
        const sample = await evaluate(html);
        samples.push({ case: entry.name, ...(mode === "capture" ? { cards: entry.cards, inputSha256: sha256(html) } : { size: html }), iteration, ...sample });
        process.stdout.write(`${entry.name} ${iteration}/${repetitions}: ${sample.capture ? `capture ${sample.capture.reduce((sum, item) => sum + item.extractionMs, 0).toFixed(1)}ms, ` : ""}import ${sample.importer.durationMs.toFixed(1)}ms, ${sample.importer.nodeCount} nodes${sample.uploads ? `, peak uploads ${sample.uploads.peak}` : ""}\n`);
      }
    }
    if (externalRequests.size) throw new Error(`Benchmark attempted external requests: ${[...externalRequests].join(", ")}`);
    for (const entry of cases) if (new Set(samples.filter((sample) => sample.case === entry.name).map((sample) => sample.sceneSha256 || sample.outputSha256)).size !== 1) throw new Error(`${entry.name} output differed across identical inputs.`);
    if (JSON.stringify(inputs) !== JSON.stringify(await inputHashes())) throw new Error("Benchmark inputs changed during the run; rerun with a stable checkout.");
    await writeFile(resolve(output), `${JSON.stringify({ schemaVersion: 1, mode, command: `npm run benchmark:importer -- ${output}${mode === "capture" ? "" : ` --${mode}`}`, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), recordedAt: new Date().toISOString(), browser, environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model }, host: "mock Penpot API in real Chrome; excludes host rendering, real network uploads and persistence", ...(mode === "assets" ? { simulatedUploadDelaysMs: [100, 20, 60], failedAssetInterval: 7, usesPerAssetPerBoard: 2 } : {}), repetitions, inputs, bundleSha256: sha256(bundle), fontSha256: sha256(font), samples }, null, 2)}\n`);
    process.stdout.write(`Wrote ${output}\n`);

    async function evaluate(html) {
      const expression = mode === "capture" ? `window.runBenchmark(${JSON.stringify(html)},${JSON.stringify(`${origin}/fixture.html`)})` : `window.runWorkload(${JSON.stringify(mode)},${html})`;
      const response = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      if (!response.result?.value) throw new Error("Benchmark returned no measurements.");
      return response.result.value;
    }
  } finally {
    await cdp?.send("Browser.close").catch(() => undefined);
    if (chrome) await closeChrome(chrome);
    if (server?.listening) await new Promise((resolveServer) => server.close(resolveServer));
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
run().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
