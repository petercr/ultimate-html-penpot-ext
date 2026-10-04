import { describe, expect, it, vi } from "vitest";
import { CaptureCancelledError, captureViewport } from "./sandbox";
import { PROTOCOL_VERSION, type CaptureRequest, type ViewportSpec } from "../shared/contracts";

const viewport: ViewportSpec = { id: "desktop", name: "Desktop", width: 400, height: 300 };
const request: Omit<CaptureRequest, "viewports"> = {
  protocolVersion: PROTOCOL_VERSION,
  html: "<main>capture</main>",
  scriptPolicy: "off",
  settleDelayMs: 0
};

describe("sandbox capture lifecycle", () => {
  it("removes the iframe when an in-flight viewport capture is cancelled", async () => {
    const controller = new AbortController();
    const pending = captureViewport(request, viewport, { signal: controller.signal });
    expect(document.querySelectorAll("iframe")).toHaveLength(1);

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(CaptureCancelledError);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("keeps profiling separate from scenes and cleans up when a profiling observer throws", async () => {
    const onMetrics = vi.fn((_metrics: unknown) => { throw new Error("Broken observer"); });
    const pending = captureViewport(request, viewport, { onMetrics });
    const iframe = document.querySelector("iframe")!;
    const token = iframe.srcdoc.match(/const token = "([^"]+)"/)?.[1];
    expect(token).toBeTruthy();
    const scene = { protocolVersion: PROTOCOL_VERSION, viewport, documentSize: { width: 400, height: 300 }, nodes: [], assets: [], diagnostics: [] };
    window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, data: { type: "CAPTURE_RESULT", token, scene, metrics: { viewportId: viewport.id, nodeCount: 0, assetCount: 0, settleMs: 1, extractionMs: 1, textMeasurementMs: 0, styleReads: 0, geometryReads: 0, textRangeReads: 0 } } }));
    await expect(pending).resolves.toEqual(scene);
    expect(onMetrics).toHaveBeenCalledOnce();
    expect(onMetrics.mock.calls[0][0]).toMatchObject({ viewportId: "desktop", durationMs: expect.any(Number), preparationMs: expect.any(Number) });
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });
});
