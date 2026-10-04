import { prepareSandboxDocument } from "./prepareDocument";
import type { CaptureRequest, SceneDocument, ViewportSpec } from "../shared/contracts";
import type { CaptureMetrics } from "../shared/performance";

const CAPTURE_TIMEOUT_MS = 15_000;

export class CaptureCancelledError extends Error {
  constructor() { super("Analysis cancelled."); }
}

export interface CaptureOptions {
  signal?: AbortSignal;
  /** A page-wide deadline; each viewport receives only its remaining budget. */
  deadline?: number;
  onMetrics?: (metrics: CaptureMetrics) => void;
}

function remainingTime(options: CaptureOptions): number {
  if (!options.deadline) return CAPTURE_TIMEOUT_MS;
  return Math.max(0, Math.min(CAPTURE_TIMEOUT_MS, options.deadline - Date.now()));
}

export async function captureViewport(request: Omit<CaptureRequest, "viewports">, viewport: ViewportSpec, options: CaptureOptions = {}): Promise<SceneDocument> {
  const started = performance.now();
  let preparationMs = 0;
  if (options.signal?.aborted) throw new CaptureCancelledError();
  const timeoutMs = remainingTime(options);
  if (!timeoutMs) throw new Error("Analysis timed out before rendering every viewport.");
  const token = crypto.randomUUID();
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute("aria-hidden", "true");
  // `visibility:hidden` can suspend requestAnimationFrame and font loading in a
  // Chromium iframe. Keep the renderer active while making it imperceptible.
  iframe.style.cssText = `position:fixed;left:-20000px;top:0;width:${viewport.width}px;height:${viewport.height}px;border:0;opacity:0;pointer-events:none;`;
  document.body.append(iframe);

  return new Promise<SceneDocument>((resolve, reject) => {
    let finished = false;
    const finish = (callback: () => void) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("message", receive);
      options.signal?.removeEventListener("abort", abort);
      window.clearTimeout(timeout);
      iframe.remove();
      callback();
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || !event.data || event.data.token !== token) return;
      if (event.data.type === "CAPTURE_RESULT") finish(() => {
        // Finish cleanup even if a developer's profiling observer throws.
        try {
          if (event.data.metrics && options.onMetrics) options.onMetrics({ ...event.data.metrics, preparationMs, durationMs: performance.now() - started });
        } catch { /* Profiling must not prevent the scene from completing. */ }
        resolve(event.data.scene as SceneDocument);
      });
      if (event.data.type === "CAPTURE_ERROR") finish(() => reject(new Error(event.data.message || "Capture failed.")));
    };
    const abort = () => finish(() => reject(new CaptureCancelledError()));
    const timeout = window.setTimeout(() => finish(() => reject(new Error(`${viewport.name} did not settle before the analysis deadline.`))), timeoutMs);
    window.addEventListener("message", receive);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const preparationStart = performance.now();
      iframe.srcdoc = prepareSandboxDocument({ ...request, viewport, token, collectMetrics: Boolean(options.onMetrics) });
      preparationMs = performance.now() - preparationStart;
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

export async function capturePage(request: CaptureRequest, onProgress?: (completed: number, total: number) => void, options: CaptureOptions = {}): Promise<SceneDocument[]> {
  const { viewports, ...shared } = request;
  const scenes: SceneDocument[] = [];
  for (const [index, viewport] of viewports.entries()) {
    if (options.signal?.aborted) throw new CaptureCancelledError();
    scenes.push(await captureViewport(shared, viewport, options));
    onProgress?.(index + 1, viewports.length);
  }
  return scenes;
}
