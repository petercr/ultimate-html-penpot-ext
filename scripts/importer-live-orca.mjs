#!/usr/bin/env node
// Drives the local validation entry through Orca's signed-in embedded tab.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [page, action, ...args] = process.argv.slice(2);
if (!page || !action) throw new Error("Usage: node scripts/importer-live-orca.mjs <browserPageId> open|run <nodes>|fixture <viewportIndex>|rotated-image|status|inspect <pageId>|focus <pageId> <layerNames...>|rotation-probe|pivot-probe|late-rotation-probe|delay-probe|cleanup <originalPageId> <testPageIds...>|network <output.json>");
const executable = process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? "orca-dev" : process.platform === "linux" ? "orca-ide" : "orca");
function call(command, options = []) {
  let output;
  try { output = execFileSync(executable, [command, "--page", page, ...options, "--json"], { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 }); }
  catch (error) { output = error.stdout; if (!output) throw error; }
  const response = JSON.parse(output);
  if (!response.ok) throw new Error(JSON.stringify(response.error));
  return response.result;
}
function evaluate(expression) {
  const result = call("eval", ["--expression", expression]).result;
  try { return JSON.parse(result); } catch { return result; }
}
function send(command) {
  return evaluate(`(() => {window.phase5Frame.contentWindow.postMessage({phase5Command:${JSON.stringify(command)}},"http://localhost:4173");return "sent"})()`);
}

if (action === "open" || action === "connect") {
  if (action === "open") {
  let snapshot = call("snapshot");
  const close = snapshot.snapshot.match(/heading "Importer host validation"[^\n]*\n- button \[ref=(e\d+)\]/);
  if (close) { call("click", ["--element", `@${close[1]}`]); snapshot = call("snapshot"); }
  const openPattern = /StaticText "Ultimate HTML to Penpot"[\s\S]*?button "OPEN" \[ref=(e\d+)\]/;
  if (!openPattern.test(snapshot.snapshot)) {
    const plugins = Object.entries(snapshot.refs).find(([, ref]) => ref.name === "Plugins (Ctrl+Alt+P)");
    if (!plugins) throw new Error("Missing plugin manager button.");
    call("click", ["--element", `@${plugins[0]}`]);
  }
  for (let attempt = 0; attempt < 5; attempt++) { snapshot = call("snapshot"); if (openPattern.test(snapshot.snapshot)) break; }
  // Some paired Electron view sizes leave native click coordinates stale.
  // Use the same observed toolbar button through the DOM when that happens.
  if (!openPattern.test(snapshot.snapshot)) {
    evaluate('document.querySelector("button[data-tool=plugins]").click();"clicked"');
    snapshot = call("snapshot");
  }
  const open = snapshot.snapshot.match(openPattern);
  if (!open) throw new Error("The local importer must already be installed.");
  evaluate('(() => {const button=[...document.querySelectorAll("button")].find(b=>b.textContent.trim().toUpperCase()==="OPEN"&&b.parentElement.textContent.includes("Ultimate HTML to Penpot"));if(!button)throw Error("Missing local plugin row");button.click();return "opened"})()');
  for (let attempt = 0; attempt < 5; attempt++) { snapshot = call("snapshot"); if (snapshot.snapshot.includes('heading "Importer host validation"')) break; }
  }
  console.log(evaluate(`(() => {
    const frames=[];const scan=root=>{frames.push(...root.querySelectorAll("iframe"));for(const el of root.querySelectorAll("*"))if(el.shadowRoot)scan(el.shadowRoot)};scan(document);
    window.phase5Frame=frames.find(f=>f.src.includes("localhost:4173"));if(!window.phase5Frame)throw Error("Missing local validation frame");
    if(window.phase5Listener)removeEventListener("message",window.phase5Listener);
    window.phase5Results=[];window.phase5Listener=event=>{if(event.source===window.phase5Frame.contentWindow&&event.data?.phase5Result)window.phase5Results.push(event.data.phase5Result)};
    addEventListener("message",window.phase5Listener);return JSON.stringify({ready:true,hostVersion:window.penpotVersion,userAgent:navigator.userAgent});
  })()`));
} else if (action === "run" || action === "assets") {
  const size = Number(args[0]);
  if (!Number.isInteger(size) || size < 2 || size > (action === "assets" ? 120 : 20000)) throw new Error("Invalid workload size.");
  console.log(send({ action, size }));
} else if (action === "status") {
  console.log(JSON.stringify(evaluate('JSON.stringify({results:window.phase5Results.filter(r=>r.type!=="progress"),last:window.phase5Results.at(-1)})'), null, 2));
} else if (action === "inspect") {
  console.log(send({ action: "inspect", pageId: args[0] }));
} else if (action === "rotation-probe") {
  console.log(send({ action: "rotation-probe" }));
} else if (action === "pivot-probe") {
  console.log(send({ action: "pivot-probe" }));
} else if (action === "late-rotation-probe") {
  console.log(send({ action: "late-rotation-probe", size: Number(args[0] ?? 1) }));
} else if (action === "delay-probe") {
  console.log(send({ action: "delay-probe" }));
} else if (action === "rotated-image") {
  console.log(send({ action: "rotated-image", size: 0 }));
} else if (action === "fixture") {
  console.log(send({ action: "fixture", size: Number(args[0] || 0) }));
} else if (action === "focus") {
  console.log(send({ action: "focus", pageId: args[0], names: args.slice(1) }));
} else if (action === "list-pages") {
  console.log(send({ action: "list-pages" }));
} else if (action === "remove-boards") {
  console.log(send({ action: "remove-boards", pageId: args[0], boardIds: args.slice(1) }));
} else if (action === "cleanup") {
  console.log(send({ action: "cleanup", pageId: args[0], pageIds: args.slice(1) }));
} else if (action === "network") {
  const requests = call("network", ["--limit", "1000"]).requests.filter((request) => request.url.includes("/update-file"));
  const measurements = requests.map((request) => ({ timestamp: request.timestamp, status: request.status,
    requestBytes: Buffer.byteLength(request.postData || ""), serverTiming: request.responseHeaders?.["server-timing"] }));
  if (args[0]) writeFileSync(args[0], JSON.stringify(measurements, null, 2) + "\n");
  console.log(JSON.stringify(measurements, null, 2));
} else throw new Error(`Unknown action: ${action}`);
