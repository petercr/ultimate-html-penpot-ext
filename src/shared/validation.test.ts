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

  it("accepts only bounded text fit scales", () => {
    const scaled = scene({ nodes: [{ ...scene().nodes[0], textFitScale: 0.8 }] });
    expect(validateScenes([scaled])).toHaveLength(1);
    expect(() => validateScenes([scene({ nodes: [{ ...scene().nodes[0], textFitScale: 0 }] })])).toThrow("textFitScale");
    expect(() => validateScenes([scene({ nodes: [{ ...scene().nodes[0], textFitScale: 1.1 }] })])).toThrow("no greater than 1");
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

  it("rejects malformed parent and child graphs before import", () => {
    const root = scene().nodes[0];
    expect(() => validateScenes([scene({ nodes: [{ ...root, id: "same" }, { ...root, id: "same" }] })])).toThrow("duplicate id");
    expect(() => validateScenes([scene({ nodes: [{ ...root, parentId: "missing" }] })])).toThrow("missing node");
    const child = { ...root, id: "child", parentId: root.id };
    expect(() => validateScenes([scene({ nodes: [root, child] })])).toThrow("missing from parent");
    const first = { ...root, id: "first", parentId: "second", children: ["second"] };
    const second = { ...root, id: "second", parentId: "first", children: ["first"] };
    expect(() => validateScenes([scene({ nodes: [first, second] })])).toThrow("parent cycle");
  });

  it("validates typed paint, layout, and text fields", () => {
    const root = scene().nodes[0];
    expect(() => validateScenes([scene({ nodes: [{ ...root, paint: { opacity: 1.1 } }] })])).toThrow("paint.opacity");
    expect(() => validateScenes([scene({ nodes: [{ ...root, layout: { kind: "table" as "none" } }] })])).toThrow("layout.kind");
    expect(() => validateScenes([scene({ nodes: [{ ...root, textStyle: { fontFamily: "Inter", fontSize: 16, fontWeight: 400, fontStyle: "normal", lineHeight: 0, letterSpacing: 0, textAlign: "left", textDecoration: "none", textTransform: "none" } }] })])).toThrow("textStyle.lineHeight");
    expect(() => validateScenes([scene({ nodes: [{ ...root, rect: { ...root.rect, width: 100_001 } }] })])).toThrow("rect.width");
  });

  it("validates asset references and duplicate viewport ids", () => {
    const root = scene().nodes[0];
    expect(() => validateScenes([scene({ nodes: [{ ...root, assetId: "missing" }] })])).toThrow("missing asset");
    expect(() => validateScenes([scene({ assets: [{ id: "asset" }] as never[] })])).toThrow("url or dataUrl");
    expect(() => validateScenes([scene(), scene()])).toThrow("duplicate viewport id");
    expect(() => validateScenes([scene({ diagnostics: [{ severity: "notice" as "info", code: "TEST", message: "bad severity" }] })])).toThrow("diagnostics[0].severity");
  });

  it("bounds the number of responsive scenes", () => {
    const scenes = Array.from({ length: 25 }, (_, index) => scene({ viewport: { id: `viewport-${index}`, name: `Viewport ${index}`, width: 400, height: 300 } }));
    expect(() => validateScenes(scenes)).toThrow("at most 24");
  });

  it("bounds aggregate layers across responsive scenes", () => {
    const scenes = Array.from({ length: 3 }, (_, sceneIndex) => scene({
      viewport: { id: `viewport-${sceneIndex}`, name: `Viewport ${sceneIndex}`, width: 400, height: 300 },
      nodes: Array.from({ length: 17_000 }, (_, index) => ({ id: `${sceneIndex}-${index}`, children: [], kind: "box" as const, name: "box", source: "div", rect: { x: 0, y: 0, width: 1, height: 1 }, zIndex: index, paint: {}, layout: { kind: "none" as const } }))
    }));
    expect(() => validateScenes(scenes)).toThrow("more than 50000 layers");
  });
});
