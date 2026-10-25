#!/usr/bin/env node
// Captures real pages through the production plugin UI and tallies the native
// flex layout decisions the importer would make for them (issue #51).
//
//   npm run build && npx vite preview --port 4173 --strictPort &
//   node scripts/importer-native-trial.mjs <output-dir> [capture|analyze]
//
// `capture` (the default) writes <output-dir>/scenes/<page>.json, the exact
// scenes the UI posts to the plugin on Import, then runs `analyze`, which
// writes <output-dir>/report.json and prints the tables.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { CdpPipe, closeChrome } from "./lib/chrome.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [output, mode = "capture"] = process.argv.slice(2);
if (!output || !["capture", "analyze"].includes(mode)) throw new Error("Usage: node scripts/importer-native-trial.mjs <output-dir> [capture|analyze]");
const uiOrigin = process.env.TRIAL_UI_ORIGIN || "http://localhost:4173";

const PAGES = [
  { name: "vite", kind: "landing", url: "https://vite.dev/" },
  { name: "stripe", kind: "landing", url: "https://stripe.com/" },
  { name: "linear", kind: "landing", url: "https://linear.app/" },
  { name: "tailwind", kind: "landing", url: "https://tailwindcss.com/" },
  { name: "github", kind: "landing", url: "https://github.com/" },
  { name: "bootstrap-dashboard", kind: "dashboard", url: "https://getbootstrap.com/docs/5.3/examples/dashboard/" },
  { name: "bootstrap-pricing", kind: "dashboard", url: "https://getbootstrap.com/docs/5.3/examples/pricing/" },
  { name: "mdn-flex", kind: "docs", url: "https://developer.mozilla.org/en-US/docs/Web/CSS/flex" },
  { name: "python-docs", kind: "docs", url: "https://docs.python.org/3/" },
  { name: "vite-guide", kind: "docs", url: "https://vite.dev/guide/" },
  { name: "bootstrap-cheatsheet", kind: "components", url: "https://getbootstrap.com/docs/5.3/examples/cheatsheet/" },
  { name: "shadcn", kind: "components", url: "https://ui.shadcn.com/" }
];

async function capture() {
  await mkdir(join(output, "scenes"), { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), "importer-native-trial-"));
  const chrome = spawn("google-chrome", ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-pipe", `--user-data-dir=${profile}`],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  const cdp = new CdpPipe(chrome.stdio[3], chrome.stdio[4], chrome, 120_000);
  const failures = [];
  try {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false }, sessionId);
    for (const page of PAGES) {
      // The UI runs in a same-origin frame so it is not standalone and posts
      // IMPORT to this window, which keeps the scenes instead of a plugin.
      await cdp.send("Page.navigate", { url: `${uiOrigin}/` }, sessionId);
      await new Promise((settle) => setTimeout(settle, 1000));
      const started = Date.now();
      try {
        const result = await evaluate(`new Promise((resolveRun, rejectRun) => {
          const frame = document.createElement("iframe");
          frame.style.cssText = "position:fixed;left:0;top:0;width:480px;height:900px";
          frame.src = ${JSON.stringify(`${uiOrigin}/`)};
          document.body.append(frame);
          const timeout = setTimeout(() => rejectRun(new Error("No IMPORT message within 90 s: " + (frame.contentDocument?.querySelector(".error")?.textContent || frame.contentDocument?.querySelector(".progress")?.textContent || ""))), 90_000);
          addEventListener("message", (event) => {
            if (event.source !== frame.contentWindow || event.data?.type !== "IMPORT") return;
            clearTimeout(timeout);
            resolveRun(JSON.stringify(event.data.scenes));
          });
          const wait = (test, label) => new Promise((ready, fail) => {
            const deadline = Date.now() + 60_000;
            const poll = () => { const value = test(); if (value) ready(value); else if (Date.now() > deadline) fail(new Error("Timed out waiting for " + label)); else setTimeout(poll, 100); };
            poll();
          });
          frame.onload = async () => {
            try {
              const doc = frame.contentDocument;
              const button = (text) => [...doc.querySelectorAll("button")].find((value) => value.textContent.trim().startsWith(text));
              const source = await wait(() => doc.querySelector("#html-source"), "the source field");
              Object.getOwnPropertyDescriptor(frame.contentWindow.HTMLTextAreaElement.prototype, "value").set.call(source, ${JSON.stringify(page.url)});
              source.dispatchEvent(new frame.contentWindow.Event("input", { bubbles: true }));
              button("Analyze page").click();
              const outcome = await wait(() => doc.querySelector(".error") || (!button("Import to Penpot")?.disabled && button("Import to Penpot")), "analysis");
              if (outcome.classList?.contains("error")) throw new Error(outcome.textContent);
              outcome.click();
              await new Promise((settle) => setTimeout(settle, 200));
              button("Import anyway")?.click();
            } catch (error) { clearTimeout(timeout); rejectRun(error); }
          };
        })`);
        const scenes = JSON.parse(result);
        await writeFile(join(output, "scenes", `${page.name}.json`), JSON.stringify({ ...page, capturedAt: new Date().toISOString(), analysisMs: Date.now() - started, scenes }));
        process.stdout.write(`${page.name}: ${scenes.map((scene) => `${scene.viewport.id} ${scene.nodes.length} nodes`).join(", ")}\n`);
      } catch (error) {
        failures.push({ page: page.name, error: String(error.message || error) });
        process.stdout.write(`${page.name}: FAILED ${error.message || error}\n`);
      }
    }
  } finally {
    await cdp.send("Browser.close").catch(() => undefined);
    await closeChrome(chrome).catch(() => undefined);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
  await writeFile(join(output, "capture-failures.json"), JSON.stringify(failures, null, 2) + "\n");
}

async function loadPlanner() {
  const result = await build({ configFile: false, logLevel: "error", build: { write: false, minify: false,
    lib: { entry: join(root, "src/importer/flexLayout.ts"), formats: ["es"], fileName: "flexLayout" } } });
  const code = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output).find((entry) => entry.type === "chunk").code;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

async function analyze() {
  const { planSceneFlex } = await loadPlanner();
  const files = (await readdir(join(output, "scenes"))).filter((file) => file.endsWith(".json")).sort();
  const pages = [];
  const reasons = new Map();
  const totals = { containers: 0, converted: 0, fill: 0, text: 0, reversed: 0, wrap: 0 };
  for (const file of files) {
    const page = JSON.parse(await readFile(join(output, "scenes", file), "utf8"));
    const viewports = page.scenes.map((scene) => {
      const decisions = planSceneFlex(scene);
      const converted = decisions.filter(({ decision }) => "plan" in decision);
      const kept = {};
      for (const { node, decision } of decisions) {
        if ("plan" in decision) continue;
        kept[decision.reason] = (kept[decision.reason] || 0) + 1;
        const entry = reasons.get(decision.reason) || { count: 0, pages: new Set(), examples: [] };
        entry.count += 1; entry.pages.add(page.name);
        if (entry.examples.length < 5) entry.examples.push(`${page.name} ${scene.viewport.id} ${node.source}`);
        reasons.set(decision.reason, entry);
      }
      totals.containers += decisions.length; totals.converted += converted.length;
      totals.fill += converted.filter(({ decision }) => decision.plan.fill.some(Boolean)).length;
      totals.text += converted.filter(({ decision }) => decision.plan.flow.some((child) => child.kind === "text")).length;
      totals.reversed += converted.filter(({ decision }) => decision.plan.dir.endsWith("-reverse")).length;
      totals.wrap += converted.filter(({ decision }) => decision.plan.wrap).length;
      return { viewport: scene.viewport.id, nodes: scene.nodes.length, flexContainers: decisions.length, converted: converted.length,
        gridContainers: scene.nodes.filter((node) => node.layout.kind === "grid").length, kept };
    });
    pages.push({ name: page.name, kind: page.kind, url: page.url, capturedAt: page.capturedAt, viewports });
  }
  const report = { generatedAt: new Date().toISOString(), totals, pages,
    reasons: [...reasons.entries()].sort((a, b) => b[1].count - a[1].count).map(([reason, entry]) => ({ reason, count: entry.count, pages: [...entry.pages].sort(), examples: entry.examples })) };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  const percent = (part, whole) => whole ? `${Math.round(part / whole * 100)}%` : "–";
  process.stdout.write("\n| Page | Kind | Viewport | Layers | Flex containers | Converted | Grid containers |\n|---|---|---|---:|---:|---:|---:|\n");
  for (const page of pages) for (const viewport of page.viewports)
    process.stdout.write(`| ${page.name} | ${page.kind} | ${viewport.viewport} | ${viewport.nodes} | ${viewport.flexContainers} | ${viewport.converted} (${percent(viewport.converted, viewport.flexContainers)}) | ${viewport.gridContainers} |\n`);
  process.stdout.write(`\nConverted ${totals.converted} of ${totals.containers} flex containers (${percent(totals.converted, totals.containers)}); ${totals.fill} use fill, ${totals.text} hold text, ${totals.reversed} are reversed, ${totals.wrap} wrap.\n`);
  process.stdout.write("\n| Kept fixed because | Containers | Share of kept | Pages |\n|---|---:|---:|---:|\n");
  const kept = totals.containers - totals.converted;
  for (const entry of report.reasons) process.stdout.write(`| ${entry.reason} | ${entry.count} | ${percent(entry.count, kept)} | ${entry.pages.length} |\n`);
}

if (mode === "capture") await capture();
await analyze();
