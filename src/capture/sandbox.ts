import { prepareSandboxDocument } from "./prepareDocument";
import type { CaptureRequest, SceneDocument, ViewportSpec } from "../shared/contracts";

const CAPTURE_TIMEOUT_MS = 15_000;

export async function captureViewport(request: Omit<CaptureRequest, "viewports">, viewport: ViewportSpec): Promise<SceneDocument> {
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
    const finish = (callback: () => void) => {
      window.removeEventListener("message", receive);
      window.clearTimeout(timeout);
      iframe.remove();
      callback();
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || !event.data || event.data.token !== token) return;
      if (event.data.type === "CAPTURE_RESULT") finish(() => resolve(event.data.scene as SceneDocument));
      if (event.data.type === "CAPTURE_ERROR") finish(() => reject(new Error(event.data.message || "Capture failed.")));
    };
    const timeout = window.setTimeout(() => finish(() => reject(new Error(`${viewport.name} did not settle within 15 seconds.`))), CAPTURE_TIMEOUT_MS);
    window.addEventListener("message", receive);
    iframe.srcdoc = prepareSandboxDocument({ ...request, viewport, token });
  });
}

export async function capturePage(request: CaptureRequest, onProgress?: (completed: number, total: number) => void): Promise<SceneDocument[]> {
  const { viewports, ...shared } = request;
  const scenes: SceneDocument[] = [];
  for (const [index, viewport] of viewports.entries()) {
    scenes.push(await captureViewport(shared, viewport));
    onProgress?.(index + 1, viewports.length);
  }
  return scenes;
}
