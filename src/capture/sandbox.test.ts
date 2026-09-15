import { describe, expect, it } from "vitest";
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
});
