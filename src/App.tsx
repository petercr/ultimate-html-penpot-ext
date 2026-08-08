import { useEffect, useMemo, useState } from "react";
import { capturePage } from "./capture/sandbox";
import { isSafeBaseUrl } from "./capture/prepareDocument";
import { resolveSource } from "./capture/source";
import { DEFAULT_VIEWPORTS, PROTOCOL_VERSION, type CaptureRequest, type PluginToUiMessage, type SceneDocument, type ScriptPolicy, type ViewportSpec } from "./shared/contracts";
import { sceneWarnings } from "./shared/validation";

type Phase = "idle" | "capturing" | "ready" | "importing" | "complete" | "error";

function postToPlugin(message: unknown) {
  window.parent.postMessage(message, "*");
}

function viewportLabel(viewport: ViewportSpec) {
  return `${viewport.name} · ${viewport.width}×${viewport.height}`;
}

export default function App() {
  const [source, setSource] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [viewports, setViewports] = useState<ViewportSpec[]>(DEFAULT_VIEWPORTS);
  const [scriptPolicy, setScriptPolicy] = useState<ScriptPolicy>("off");
  const [settleDelayMs, setSettleDelayMs] = useState(300);
  const [scenes, setScenes] = useState<SceneDocument[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string>();
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    const receive = (event: MessageEvent<PluginToUiMessage>) => {
      const message = event.data;
      if (!message || typeof message !== "object" || !("type" in message)) return;
      if (message.type === "PROGRESS") setProgress(`${message.label}: ${message.completed}/${message.total}`);
      if (message.type === "COMPLETE") {
        setPhase("complete");
        setProgress(`Imported ${message.boards} editable board${message.boards === 1 ? "" : "s"}.`);
      }
      if (message.type === "ERROR") {
        setPhase("error");
        setError(message.message);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  const warnings = useMemo(() => sceneWarnings(scenes), [scenes]);
  const diagnostics = useMemo(() => scenes.flatMap((scene) => scene.diagnostics), [scenes]);
  const resetCapture = () => {
    setScenes([]);
    if (phase !== "importing") setPhase("idle");
  };

  const analyze = async () => {
    if (!source.trim()) {
      setPhase("error");
      setError("Paste the HTML for one page before analyzing it.");
      return;
    }
    if (baseUrl && !isSafeBaseUrl(baseUrl)) {
      setPhase("error");
      setError("The base URL must use http:// or https://.");
      return;
    }
    if (scriptPolicy === "trusted" && !window.confirm("Only enable scripts for source you trust. A sandbox prevents access to Penpot, but a broken or hostile script can still hang this plugin tab. Continue?")) return;
    setError(undefined);
    setScenes([]);
    setPhase("capturing");
    setProgress("Preparing page…");
    try {
      const resolved = await resolveSource(source, baseUrl || undefined);
      const request: CaptureRequest = { protocolVersion: PROTOCOL_VERSION, html: resolved.html, baseUrl: resolved.baseUrl, viewports, scriptPolicy, settleDelayMs };
      const captured = await capturePage(request, (completed, total) => setProgress(`Rendered ${completed}/${total} viewport${total === 1 ? "" : "s"}.`));
      setScenes(captured);
      setPhase("ready");
      setProgress(`Analyzed ${captured.length} viewport${captured.length === 1 ? "" : "s"}.`);
    } catch (captureError) {
      setPhase("error");
      setError(captureError instanceof Error ? captureError.message : "Unable to render the supplied page.");
    }
  };

  const importScenes = () => {
    if (!scenes.length) return;
    if ((warnings.needsLayerConfirmation || warnings.tallViewports.length) && !window.confirm(`This import contains ${warnings.layers.toLocaleString()} layers${warnings.tallViewports.length ? ` and tall boards (${warnings.tallViewports.join(", ")})` : ""}. It may be slow. Import anyway?`)) return;
    setPhase("importing");
    setError(undefined);
    setProgress("Preparing Penpot layers…");
    postToPlugin({ type: "IMPORT", protocolVersion: PROTOCOL_VERSION, scenes });
  };

  const cancel = () => {
    postToPlugin({ type: "CANCEL", protocolVersion: PROTOCOL_VERSION });
    setProgress("Cancelling after the current layer…");
  };

  const updateViewport = (id: string, field: keyof ViewportSpec, value: string) => {
    setViewports((current) => current.map((viewport) => viewport.id !== id ? viewport : field === "name" || field === "id" ? { ...viewport, [field]: value } : { ...viewport, [field]: Math.max(1, Number(value) || 1) }));
    resetCapture();
  };

  return <main className="app-shell">
    <header>
      <div>
        <h1>Ultimate HTML to Penpot</h1>
        <p>Turn one rendered HTML page into editable boards.</p>
      </div>
      <span className={`status status-${phase}`}>{phase === "ready" ? "Ready" : phase === "importing" ? "Importing" : phase === "capturing" ? "Analyzing" : phase === "complete" ? "Done" : "Draft"}</span>
    </header>

    <section className="source-section" aria-label="Page source">
      <label htmlFor="base-url">Base URL <span>optional — resolves relative assets when pasting HTML</span></label>
      <input id="base-url" value={baseUrl} placeholder="https://example.com/page/" onChange={(event) => { setBaseUrl(event.target.value); resetCapture(); }} />
      <label htmlFor="html-source">Page source <span>paste complete HTML or enter a full HTTP(S) URL</span></label>
      <textarea id="html-source" className="editor" value={source} spellCheck={false} aria-label="HTML source" placeholder="<!doctype html>\n<html>…</html>\n\n—or—\n\nhttps://example.com/page" onChange={(event) => { setSource(event.target.value); resetCapture(); }} />
    </section>

    <section className="viewport-section">
      <div className="section-heading"><h2>Responsive boards</h2><button className="text-button" onClick={() => { setViewports([...viewports, { id: crypto.randomUUID(), name: "Custom", width: 1024, height: 800 }]); resetCapture(); }}>Add viewport</button></div>
      <div className="viewport-list">
        {viewports.map((viewport) => <div className="viewport-row" key={viewport.id}>
          <input aria-label={`${viewport.name} name`} value={viewport.name} onChange={(event) => updateViewport(viewport.id, "name", event.target.value)} />
          <input aria-label={`${viewport.name} width`} type="number" min="1" value={viewport.width} onChange={(event) => updateViewport(viewport.id, "width", event.target.value)} />
          <span>×</span>
          <input aria-label={`${viewport.name} height`} type="number" min="1" value={viewport.height} onChange={(event) => updateViewport(viewport.id, "height", event.target.value)} />
          <button aria-label={`Remove ${viewport.name}`} className="icon-button" disabled={viewports.length === 1} onClick={() => { setViewports(viewports.filter((item) => item.id !== viewport.id)); resetCapture(); }}>×</button>
        </div>)}
      </div>
    </section>

    <section className="advanced-section">
      <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>Advanced capture {advanced ? "−" : "+"}</button>
      {advanced && <div className="advanced-panel">
        <label className="checkbox"><input type="checkbox" checked={scriptPolicy === "trusted"} onChange={(event) => { setScriptPolicy(event.target.checked ? "trusted" : "off"); resetCapture(); }} /> Run trusted page scripts <span>Off by default. Never use for untrusted HTML.</span></label>
        <label>Additional settle delay <output>{settleDelayMs}ms</output><input type="range" min="0" max="5000" step="100" value={settleDelayMs} onChange={(event) => { setSettleDelayMs(Number(event.target.value)); resetCapture(); }} /></label>
      </div>}
    </section>

    {scenes.length > 0 && <section className="analysis" aria-live="polite">
      <h2>Analysis</h2>
      <div className="summary"><strong>{warnings.layers.toLocaleString()}</strong> editable layers across {scenes.length} boards · {diagnostics.length} diagnostics</div>
      <ul>
        {scenes.map((scene) => <li key={scene.viewport.id}>{viewportLabel(scene.viewport)} — {scene.documentSize.width}×{Math.round(scene.documentSize.height)}px, {scene.nodes.length} layers</li>)}
        {diagnostics.slice(0, 4).map((diagnostic, index) => <li className="warning" key={`${diagnostic.code}-${index}`}>{diagnostic.message} {diagnostic.source ? `(${diagnostic.source})` : ""}</li>)}
        {diagnostics.length > 4 && <li className="warning">+ {diagnostics.length - 4} more diagnostics</li>}
      </ul>
    </section>}

    {error && <p className="error" role="alert">{error}</p>}
    {(phase === "capturing" || phase === "importing" || phase === "complete" || phase === "ready") && <p className="progress" aria-live="polite">{progress}</p>}
    <footer>
      {phase === "importing" ? <button className="secondary" onClick={cancel}>Cancel import</button> : <button className="secondary" onClick={analyze} disabled={phase === "capturing"}>Analyze page</button>}
      <button className="primary" onClick={importScenes} disabled={phase !== "ready"}>Import to Penpot</button>
    </footer>
  </main>;
}
