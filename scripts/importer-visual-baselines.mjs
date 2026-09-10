#!/usr/bin/env node
/**
 * Regenerate the checked-in browser references for the importer fixtures.
 *
 * No browser automation package is needed: Chrome's remote-debugging pipe is
 * sufficient for real layout, font readiness checks, screenshots, and the
 * same self-contained extractor script used by the capture sandbox.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import typescript from "typescript";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = join(repositoryRoot, "src", "capture", "fixtures");
const outputDirectory = join(fixtureDirectory, "baselines");
const extractorPath = join(repositoryRoot, "src", "capture", "extractor.ts");
const fontFamily = "DejaVu Sans";
// Keep scene asset URLs reproducible in checked-in evidence. The interactive
// comparison server intentionally uses the adjacent port 4174 instead.
const baselinePort = 4175;
const fixtureFiles = [
  "background-images.html",
  "overflow-clipping.html",
  "color-opacity.html",
  "stacking-contents-whitespace.html",
  "asset-failures.html"
];
const fixtureAssetDirectory = join(fixtureDirectory, "assets");
const CDP_COMMAND_TIMEOUT_MS = 15_000;
const viewports = [
  // Keep this synchronized with DEFAULT_VIEWPORTS in src/shared/contracts.ts.
  // Screenshot filenames retain their established width-based suffixes below.
  { id: "desktop", name: "Desktop", width: 1440, height: 900 },
  { id: "tablet", name: "Tablet", width: 768, height: 1024 },
  { id: "mobile", name: "Mobile", width: 390, height: 844 }
];

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requestPathname(requestUrl) {
  try {
    return decodeURIComponent(new URL(requestUrl, "http://fixture.local").pathname);
  } catch {
    return undefined;
  }
}

function localPathname(pathname) {
  if (!pathname) return undefined;
  const target = resolve(fixtureDirectory, `.${pathname}`);
  return target.startsWith(`${fixtureDirectory}${sep}`) || target === fixtureDirectory ? target : undefined;
}

async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    const pathname = requestPathname(request.url || "/");
    if (!pathname) {
      response.writeHead(400, { "Cache-Control": "no-store" });
      response.end("Malformed fixture URL");
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const target = localPathname(pathname);
    if (!target || !relative(fixtureDirectory, target) || normalize(target) === fixtureDirectory) {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end("Fixture not found");
      return;
    }
    try {
      const bytes = await readFile(target);
      const contentType = mimeTypes[extname(target).toLowerCase()] || "application/octet-stream";
      response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        // The fixtures intentionally use only same-origin, data: assets.
        // This is a second guard in addition to CDP request interception.
        "Content-Security-Policy": "default-src 'self' data:; base-uri 'none'; connect-src 'none'; font-src 'self'; img-src 'self' data:; media-src 'none'; object-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'",
        "Content-Type": contentType
      });
      response.end(bytes);
    } catch {
      // asset-failures.html deliberately requests this 404 route. It stays
      // same-origin and is recorded in metadata instead of reaching a host.
      response.writeHead(404, { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Fixture asset intentionally absent");
    }
  });
  await new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(baselinePort, "127.0.0.1", () => resolveServer(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not obtain a loopback port.");
  if (address.port !== baselinePort) throw new Error(`Fixture server must use fixed port ${baselinePort}.`);
  return {
    origin: `http://127.0.0.1:${baselinePort}`,
    close: () => new Promise((resolveServer, rejectServer) => server.close((error) => error ? rejectServer(error) : resolveServer(undefined)))
  };
}

/** Minimal NUL-delimited CDP peer for Chrome's --remote-debugging-pipe. */
class CdpPipe {
  #input;
  #output;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #buffer = Buffer.alloc(0);
  #failure;

  constructor(input, output, chrome) {
    this.#input = input;
    this.#output = output;
    output.on("data", (chunk) => this.#receive(chunk));
    const fail = (source, error) => this.#failAll(new Error(`CDP ${source}: ${error instanceof Error ? error.message : error}`));
    input.on("error", (error) => fail("stdin error", error));
    input.on("close", () => fail("stdin closed", "Chrome closed the debugging pipe"));
    output.on("error", (error) => fail("stdout error", error));
    output.on("end", () => fail("stdout ended", "Chrome closed the debugging pipe"));
    output.on("close", () => fail("stdout closed", "Chrome closed the debugging pipe"));
    chrome.on("error", (error) => fail("Chrome process error", error));
    chrome.on("exit", (code, signal) => fail("Chrome process exited", `code ${code ?? "null"}, signal ${signal ?? "none"}`));
    chrome.on("close", (code, signal) => fail("Chrome process closed", `code ${code ?? "null"}, signal ${signal ?? "none"}`));
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) || [];
    listeners.push(listener);
    this.#listeners.set(method, listeners);
  }

  send(method, params = {}, sessionId) {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    const frame = Buffer.from(`${JSON.stringify(message)}\0`);
    return new Promise((resolveMessage, rejectMessage) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        rejectMessage(new Error(`${method} timed out after ${CDP_COMMAND_TIMEOUT_MS}ms.`));
      }, CDP_COMMAND_TIMEOUT_MS);
      this.#pending.set(id, { resolve: resolveMessage, reject: rejectMessage, timeout });
      try {
        this.#input.write(frame, (error) => {
          if (!error) return;
          const pending = this.#pending.get(id);
          this.#pending.delete(id);
          if (pending) clearTimeout(pending.timeout);
          rejectMessage(error);
        });
      } catch (error) {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        if (pending) clearTimeout(pending.timeout);
        rejectMessage(error);
      }
    }).then((messageResult) => {
      if (messageResult.error) throw new Error(`${method}: ${messageResult.error.message || JSON.stringify(messageResult.error)}`);
      return messageResult.result;
    });
  }

  #receive(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.includes(0)) {
      const end = this.#buffer.indexOf(0);
      let message;
      try {
        message = JSON.parse(this.#buffer.subarray(0, end).toString("utf8"));
      } catch (error) {
        this.#failAll(new Error(`Invalid CDP message: ${error instanceof Error ? error.message : error}`));
        return;
      }
      this.#buffer = this.#buffer.subarray(end + 1);
      if (message.id) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (pending) clearTimeout(pending.timeout);
        pending?.resolve(message);
      } else {
        for (const listener of this.#listeners.get(message.method) || []) listener(message);
      }
    }
  }

  #failAll(error) {
    if (this.#failure) return;
    this.#failure = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.#failure);
    }
    this.#pending.clear();
  }
}

async function extractorScript() {
  const source = await readFile(extractorPath, "utf8");
  const contractSource = await readFile(join(repositoryRoot, "src", "shared", "contracts.ts"), "utf8");
  const protocolVersion = contractSource.match(/PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1];
  if (!protocolVersion) throw new Error("Could not resolve the capture protocol version.");
  const compiled = typescript.transpileModule(source, {
    compilerOptions: { target: typescript.ScriptTarget.ES2022, module: typescript.ModuleKind.ESNext }
  }).outputText.replace(/^import \{ PROTOCOL_VERSION \} from ["']\.\.\/shared\/contracts["'];?\s*$/m, `const PROTOCOL_VERSION = ${protocolVersion};`);
  if (compiled.includes("../shared/contracts")) throw new Error("Extractor compilation retained an unresolved local import.");
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  return { buildExtractor: (await import(moduleUrl)).buildExtractorScript, sha256: sha256(source) };
}

async function fixtureInputHashes() {
  const assetFiles = (await readdir(fixtureAssetDirectory))
    .filter((file) => [".svg", ".ttf", ".otf", ".woff", ".woff2"].includes(extname(file).toLowerCase()))
    .sort();
  return Promise.all(assetFiles.map(async (file) => {
    const path = join(fixtureAssetDirectory, file);
    return { path: relative(repositoryRoot, path).split(sep).join("/"), sha256: sha256(await readFile(path)) };
  }));
}

function pngDimensions(bytes) {
  const signature = "89504e470d0a1a0a";
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== signature || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("Chrome returned an invalid PNG screenshot.");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function sceneNode(scene, source) {
  const node = scene.nodes.find((candidate) => candidate.source === source);
  if (!node) throw new Error(`Expected captured node ${source}.`);
  return node;
}

function assertSceneEvidence(file, scene, failedAssetUrls) {
  if (file === "background-images.html") {
    const root = sceneNode(scene, "body");
    const container = sceneNode(scene, "#container-image");
    const reused = sceneNode(scene, "#reused-background");
    const image = sceneNode(scene, "#image-reuse");
    if (!root.paint.backgroundImage?.includes("checker-tile.svg")) throw new Error("Root background image was not captured.");
    if (!container.assetId || container.assetId !== reused.assetId) throw new Error("Repeated container background did not reuse one scene asset.");
    if (!image.assetId || !scene.assets.some((asset) => asset.id === image.assetId && asset.url?.includes("fixture-illustration.svg"))) throw new Error("Bundled image asset was not captured.");
  }
  if (file === "overflow-clipping.html") {
    for (const source of ["#oversized", "#rounded", "#outer-clip", "#inner-clip", "#scrollable"]) {
      if (sceneNode(scene, source).paint.overflow !== "hidden") throw new Error(`${source} did not retain two-axis clipping.`);
    }
    if (sceneNode(scene, "#single-axis").paint.overflow !== "visible") throw new Error("Single-axis clipping should remain unclipped.");
    if (!scene.diagnostics.some((diagnostic) => diagnostic.code === "UNSUPPORTED_OVERFLOW" && diagnostic.source === "#single-axis")) throw new Error("Single-axis clipping diagnostic is missing.");
  }
  if (file === "color-opacity.html") {
    if (sceneNode(scene, "#alpha-card").paint.opacity !== 1) throw new Error("Color fixture card opacity unexpectedly changed.");
    if (sceneNode(scene, "#nested-opacity").paint.opacity !== 0.5) throw new Error("Nested opacity parent was not captured.");
    if (sceneNode(scene, "#decorated-text").paint.opacity !== 0.5) throw new Error("Decorated compositing opacity was not captured.");
    if (!scene.diagnostics.some((diagnostic) => diagnostic.code === "UNSUPPORTED_COLOR_FORMAT")) throw new Error("Color fixture diagnostic is missing.");
  }
  if (file === "stacking-contents-whitespace.html") {
    for (const source of ["#stack-negative", "#stack-auto", "#stack-zero", "#stack-positive", "#contents-child", "#whitespace-sample ::text", "#nbsp-comment-sample ::text"]) sceneNode(scene, source);
    if (scene.nodes.some((node) => node.source === "#contents")) throw new Error("display: contents wrapper must not create a scene node.");
  }
  if (file === "asset-failures.html") {
    const first = sceneNode(scene, "#missing-image-a");
    const repeated = sceneNode(scene, "#missing-image-b");
    const background = sceneNode(scene, "#missing-background");
    if (!first.assetId || first.assetId !== repeated.assetId || first.assetId !== background.assetId) throw new Error("Failed local asset was not shared across fixture uses.");
    if (!failedAssetUrls.some((url) => url.endsWith("/assets/intentional-missing.png"))) throw new Error("Controlled failed asset response was not observed.");
  }
}

function assertRequestEvidence(file, intentionalMissingUrl, responseFailures, networkFailures, blockedRequests) {
  const failedUrls = new Set([...responseFailures, ...networkFailures, ...blockedRequests]);
  const unexpected = [...failedUrls].filter((url) => file !== "asset-failures.html" || url !== intentionalMissingUrl);
  if (unexpected.length) throw new Error(`${file} had unexpected missing or blocked subresources: ${unexpected.sort().join(", ")}`);
  if (file !== "asset-failures.html" && failedUrls.size) throw new Error(`${file} must not have missing or blocked subresources.`);
  if (file === "asset-failures.html" && !responseFailures.has(intentionalMissingUrl)) {
    throw new Error("asset-failures.html did not receive the intentional missing asset response.");
  }
}

async function waitForReady(cdp, sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = await cdp.send("Runtime.evaluate", { expression: "document.readyState === 'complete'", returnByValue: true }, sessionId);
      if (value.result.value) return;
    } catch (error) {
      if (!String(error).includes("Execution context")) throw error;
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
  }
  throw new Error("Fixture page did not reach readyState=complete.");
}

async function captureScene(cdp, sessionId, buildExtractor, viewport) {
  const token = `fixture-${viewport.id}`;
  const script = buildExtractor(token, viewport, 0);
  const expression = `new Promise((resolve, reject) => {
    const token = ${JSON.stringify(token)};
    const timeout = setTimeout(() => reject(new Error("Extractor timed out")), 10_000);
    addEventListener("message", function receive(event) {
      if (event.data?.token !== token) return;
      removeEventListener("message", receive);
      clearTimeout(timeout);
      if (event.data.type === "CAPTURE_RESULT") resolve(event.data.scene);
      else reject(new Error(event.data.message || "Extractor failed"));
    });
    eval(${JSON.stringify(script)});
  })`;
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  return result.result.value;
}

async function closeChrome(chrome) {
  if (chrome.exitCode !== null) return;
  await new Promise((resolveExit) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.removeListener("exit", finish);
      chrome.removeListener("close", finish);
      resolveExit(undefined);
    };
    const timeout = setTimeout(() => {
      try { chrome.kill("SIGKILL"); } catch { /* Cleanup is best effort after a bounded wait. */ }
      finish();
    }, 5_000);
    chrome.once("exit", finish);
    chrome.once("close", finish);
    try { chrome.kill("SIGTERM"); } catch { finish(); }
  });
}

async function run() {
  const { buildExtractor, sha256: extractorSha256 } = await extractorScript();
  const inputAssets = await fixtureInputHashes();
  let fixtureServer;
  let profileDirectory;
  let chrome;
  let cdp;
  try {
    fixtureServer = await startFixtureServer();
    profileDirectory = await mkdtemp(join(tmpdir(), "importer-fixture-chrome-"));
    chrome = spawn("google-chrome", [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--no-default-browser-check",
      "--no-first-run",
      "--remote-debugging-pipe",
      `--user-data-dir=${profileDirectory}`
    ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    const cdpStdin = chrome.stdio[3];
    const cdpStdout = chrome.stdio[4];
    if (!cdpStdin || !cdpStdout) throw new Error("Chrome did not expose its remote-debugging stdin/stdout pipes.");
    cdp = new CdpPipe(cdpStdin, cdpStdout, chrome);

    const externalRequests = new Set();
    const responseFailures = new Set();
    const networkFailures = new Set();
    const blockedRequests = new Set();
    const requestUrls = new Map();
    const intentionalMissingUrl = `${fixtureServer.origin}/assets/intentional-missing.png`;
    const browser = await cdp.send("Browser.getVersion");
    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "http://*" }, { urlPattern: "https://*" }] }, sessionId);
    cdp.on("Network.requestWillBeSent", (event) => {
      if (event.sessionId === sessionId) requestUrls.set(event.params.requestId, event.params.request.url);
    });
    cdp.on("Fetch.requestPaused", (event) => {
      if (event.sessionId !== sessionId) return;
      const url = event.params.request.url;
      const allowed = url.startsWith(`${fixtureServer.origin}/`);
      if (!allowed) {
        externalRequests.add(url);
        blockedRequests.add(url);
        void cdp.send("Fetch.failRequest", { requestId: event.params.requestId, errorReason: "AccessDenied" }, sessionId).catch(() => undefined);
      } else void cdp.send("Fetch.continueRequest", { requestId: event.params.requestId }, sessionId).catch(() => undefined);
    });
    cdp.on("Network.responseReceived", (event) => {
      if (event.sessionId !== sessionId) return;
      const { response } = event.params;
      if (response.status >= 400) responseFailures.add(response.url);
    });
    cdp.on("Network.loadingFailed", (event) => {
      if (event.sessionId !== sessionId || event.params.canceled) return;
      networkFailures.add(requestUrls.get(event.params.requestId) || `unknown request (${event.params.errorText || "network failure"})`);
    });

    const metadata = {
      schemaVersion: 1,
      command: "npm run baseline:importer",
      browser: { product: browser.product, revision: browser.revision, userAgent: browser.userAgent },
      fixtureServer: "loopback only; all external http(s) requests are failed through CDP Fetch interception",
      externalRequestsRejected: [],
      inputs: {
        extractor: { path: relative(repositoryRoot, extractorPath).split(sep).join("/"), sha256: extractorSha256 },
        assets: inputAssets
      },
      fixtures: []
    };
    const sceneEvidence = { schemaVersion: 1, command: "npm run baseline:importer", fixtures: [] };

    for (const file of fixtureFiles) {
      const source = await readFile(join(fixtureDirectory, file));
      const fixtureEvidence = { file, sha256: sha256(source), viewports: [] };
      const fixtureScenes = { file, sha256: sha256(source), viewports: [] };
      for (const viewport of viewports) {
        responseFailures.clear();
        networkFailures.clear();
        blockedRequests.clear();
        requestUrls.clear();
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 1,
          mobile: false,
          screenWidth: viewport.width,
          screenHeight: viewport.height
        }, sessionId);
        await cdp.send("Page.navigate", { url: `${fixtureServer.origin}/${file}` }, sessionId);
        await waitForReady(cdp, sessionId);
        const pageState = await cdp.send("Runtime.evaluate", {
          expression: `Promise.all([document.fonts.load(${JSON.stringify(`400 16px "${fontFamily}"`)}), document.fonts.load(${JSON.stringify(`700 16px "${fontFamily}"`)})]).then(() => document.fonts.ready).then(() => ({ innerWidth, innerHeight, devicePixelRatio, fontStatus: document.fonts.status, fixtureFontRegularReady: document.fonts.check(${JSON.stringify(`400 16px "${fontFamily}"`)}), fixtureFontBoldReady: document.fonts.check(${JSON.stringify(`700 16px "${fontFamily}"`)}), fontFaces: [...document.fonts].filter((face) => face.family.includes(${JSON.stringify(fontFamily)})).map((face) => ({ family: face.family, status: face.status, weight: face.weight, style: face.style })) }))`,
          awaitPromise: true,
          returnByValue: true
        }, sessionId);
        const state = pageState.result.value;
        if (state.innerWidth !== viewport.width || state.innerHeight !== viewport.height || state.devicePixelRatio !== 1) throw new Error(`${file} ${viewport.id} did not receive the requested CSS viewport, height, or device scale.`);
        const regularLoaded = state.fontFaces.some((face) => face.weight === "400" && face.status === "loaded");
        const boldLoaded = state.fontFaces.some((face) => face.weight === "700" && face.status === "loaded");
        if (state.fontStatus !== "loaded" || !state.fixtureFontRegularReady || !state.fixtureFontBoldReady || !regularLoaded || !boldLoaded) throw new Error(`${file} ${viewport.id} did not load regular and bold ${fontFamily}.`);
        const scene = await captureScene(cdp, sessionId, buildExtractor, viewport);
        assertRequestEvidence(file, intentionalMissingUrl, responseFailures, networkFailures, blockedRequests);
        const failedAssetUrls = [...responseFailures].sort();
        assertSceneEvidence(file, scene, failedAssetUrls);
        const layout = await cdp.send("Page.getLayoutMetrics", {}, sessionId);
        const contentSize = layout.cssContentSize || layout.contentSize;
        if (!contentSize?.width || !contentSize?.height) throw new Error(`${file} ${viewport.id} did not provide full-page layout metrics.`);
        const clip = { x: 0, y: 0, width: Math.ceil(contentSize.width), height: Math.ceil(contentSize.height), scale: 1 };
        const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: true, clip }, sessionId);
        const png = Buffer.from(screenshot.data, "base64");
        const screenshotFile = `${file.replace(/\.html$/, "")}-${viewport.id === "desktop" ? "desktop-1440" : viewport.id === "tablet" ? "tablet-768" : "mobile-390"}.png`;
        await writeFile(join(outputDirectory, screenshotFile), png);
        fixtureEvidence.viewports.push({
          ...viewport,
          screenshot: screenshotFile,
          ...state,
          failedAssetUrls,
          requestFailures: { responseFailures: failedAssetUrls, networkFailures: [...networkFailures].sort(), blockedRequests: [...blockedRequests].sort() },
          layout: { cssLayoutViewport: layout.cssLayoutViewport, cssContentSize: contentSize },
          capture: { mode: "full-page", clip },
          png: pngDimensions(png)
        });
        fixtureScenes.viewports.push({ ...viewport, scene });
      }
      metadata.fixtures.push(fixtureEvidence);
      sceneEvidence.fixtures.push(fixtureScenes);
    }
    metadata.externalRequestsRejected = [...externalRequests].sort();
    if (metadata.externalRequestsRejected.length) throw new Error(`External requests were rejected: ${metadata.externalRequestsRejected.join(", ")}`);
    await writeFile(join(outputDirectory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    await writeFile(join(outputDirectory, "scene-evidence.json"), `${JSON.stringify(sceneEvidence, null, 2)}\n`);
    process.stdout.write(`Wrote ${fixtureFiles.length * viewports.length} screenshots, metadata, and scene evidence to ${relative(repositoryRoot, outputDirectory)}.\n`);
  } finally {
    await cdp?.send("Browser.close").catch(() => undefined);
    if (chrome) await closeChrome(chrome).catch(() => undefined);
    if (fixtureServer) await fixtureServer.close().catch(() => undefined);
    if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : error}\n`);
  process.exitCode = 1;
});
