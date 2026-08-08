import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type SceneDocument } from "./contracts";
import { sceneWarnings, utf8ByteLength, validateScenes } from "./validation";

function scene(overrides: Partial<SceneDocument> = {}): SceneDocument {
  return {
    protocolVersion: PROTOCOL_VERSION,
    viewport: { id: "desktop", name: "Desktop", width: 1440, height: 900 },
    documentSize: { width: 1440, height: 900 },
    nodes: [{ id: "root", children: [], kind: "container", name: "body", source: "body", rect: { x: 0, y: 0, width: 1440, height: 900 }, zIndex: 1, paint: {}, layout: { kind: "none" } }],
    assets: [],
    diagnostics: [],
    ...overrides
  };
}

describe("scene validation", () => {
  it("accepts a protocol-compatible scene", () => {
    expect(validateScenes([scene()])).toHaveLength(1);
  });

  it("rejects impossible document height", () => {
    expect(() => validateScenes([scene({ documentSize: { width: 1440, height: 100_001 } })])).toThrow("100,000px");
  });

  it("reports confirmation thresholds", () => {
    const manyNodes = Array.from({ length: 5_001 }, (_, index) => ({ id: `n-${index}`, children: [], kind: "box" as const, name: "box", source: "div", rect: { x: 0, y: 0, width: 1, height: 1 }, zIndex: index, paint: {}, layout: { kind: "none" as const } }));
    const warnings = sceneWarnings([scene({ nodes: manyNodes, documentSize: { width: 1440, height: 30_001 } })]);
    expect(warnings.needsLayerConfirmation).toBe(true);
    expect(warnings.tallViewports).toEqual(["Desktop"]);
  });

  it("counts UTF-8 bytes without relying on TextEncoder", () => {
    expect(utf8ByteLength("Aé€😀")).toBe(10);
  });
});
