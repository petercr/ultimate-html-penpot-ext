import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, SCENE_LIMITS, type SceneDocument, type SceneImageFit, type SceneNode } from "./contracts";
import { validateScenes } from "./validation";

function imageNode(overrides: Partial<SceneNode> = {}): SceneNode {
  return {
    id: "image", children: [], kind: "image", name: "Image", source: "#image", zIndex: 0,
    rect: { x: 20, y: 30, width: 200, height: 200 }, paint: {}, layout: { kind: "none" }, assetId: "asset",
    image: {
      fit: "contain", intrinsicWidth: 400, intrinsicHeight: 200,
      position: { x: { percentage: 0.5, offset: 0 }, y: { percentage: 0.5, offset: 0 } }
    }, ...overrides
  };
}

function scene(node = imageNode()): SceneDocument {
  return {
    protocolVersion: PROTOCOL_VERSION,
    viewport: { id: "desktop", name: "Desktop", width: 1440, height: 900 },
    documentSize: { width: 1440, height: 900 }, nodes: [node],
    assets: [{ id: "asset", dataUrl: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22400%22%20height%3D%22200%22%2F%3E", mimeType: "image/svg+xml" }],
    diagnostics: []
  };
}

function fitNode(overrides: Partial<SceneImageFit>): SceneNode {
  const node = imageNode();
  return { ...node, image: { ...node.image!, ...overrides } };
}

describe("image fit scene validation", () => {
  it.each(["fill", "contain", "cover", "none", "scale-down"] as const)("accepts complete %s metadata", (fit) => {
    expect(validateScenes([scene(fitNode({ fit }))])).toHaveLength(1);
  });

  it("accepts legacy image nodes without fit metadata", () => {
    expect(validateScenes([scene(imageNode({ image: undefined }))])).toHaveLength(1);
  });

  it.each(["width", "height"] as const)("rejects an underflowing element %s even when the fitted object is usable", (axis) => {
    const node = fitNode({ fit: "none" });
    node.rect = { x: 0, y: 0, width: 200, height: 200, [axis]: 1e-300 };
    expect(() => validateScenes([scene(node)])).toThrow("image element dimensions");
  });

  it.each(["width", "height"] as const)("rejects an underflowing content %s inside a usable element", (axis) => {
    const node = fitNode({ fit: "none" });
    node.rect = { x: 0, y: 0, width: 1, height: 1 };
    node.layout.padding = axis === "width" ? [0, 0.9999999, 0, 0] : [0.9999999, 0, 0, 0];
    expect(() => validateScenes([scene(node)])).toThrow("image content dimensions");
  });

  it("accepts zero-sized element and content boxes and dimensions at the positive minimum", () => {
    for (const rect of [
      { x: 0, y: 0, width: 0, height: 200 },
      { x: 0, y: 0, width: 200, height: 0 },
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: 0.000001, height: 0.000001 }
    ]) {
      const node = fitNode({ fit: "none" });
      node.rect = rect;
      expect(validateScenes([scene(node)])).toHaveLength(1);
    }
    const emptyContent = imageNode({ layout: { kind: "none", padding: [100, 100, 100, 100] } });
    expect(validateScenes([scene(emptyContent)])).toHaveLength(1);
  });

  it("accepts transformed natural dimensions and positions outside the 0..1 interval", () => {
    const node = fitNode({
      fit: "none", intrinsicWidth: 80, intrinsicHeight: 30, scale: 1.5,
      position: { x: { percentage: 1.25, offset: -12 }, y: { percentage: -0.25, offset: 8 } }
    });
    node.rotation = 35;
    expect(validateScenes([scene(node)])).toHaveLength(1);
  });

  it("accepts the capture transform threshold when the normalized viewport stays bounded", () => {
    const node = fitNode({ fit: "none", scale: 0.0001 });
    node.rect = { x: 0, y: 0, width: 0.04, height: 0.02 };
    expect(validateScenes([scene(node)])).toHaveLength(1);
  });

  it("requires fit metadata to belong to an image with an asset reference", () => {
    for (const kind of ["container", "box", "svg", "text", "fallback"] as const) {
      expect(() => validateScenes([scene(imageNode({ kind }))])).toThrow("image requires an image node with an assetId");
    }
    expect(() => validateScenes([scene(imageNode({ assetId: undefined }))])).toThrow("image requires an image node with an assetId");
    expect(() => validateScenes([scene(imageNode({ assetId: "missing" }))])).toThrow("references missing asset");
  });

  it("requires metadata to be an object and fit to be a supported string", () => {
    for (const image of [null, [], "contain"]) {
      expect(() => validateScenes([scene(imageNode({ image: image as unknown as SceneImageFit }))])).toThrow("image must be an object");
    }
    for (const fit of [undefined, null, 3, "stretch", "CONTAIN"]) {
      expect(() => validateScenes([scene(fitNode({ fit: fit as SceneImageFit["fit"] }))])).toThrow("image.fit");
    }
  });

  it("requires both bounded positive natural dimensions", () => {
    for (const field of ["intrinsicWidth", "intrinsicHeight"] as const) {
      for (const amount of [undefined, null, "100", 0, -1, Number.NaN, Number.POSITIVE_INFINITY, SCENE_LIMITS.maxDimension + 1]) {
        expect(() => validateScenes([scene(fitNode({ [field]: amount } as Partial<SceneImageFit>))])).toThrow(`image.${field}`);
      }
    }
  });

  it("rejects positive fitted dimensions too small for host geometry", () => {
    expect(() => validateScenes([scene(fitNode({ fit: "none", scale: Number.MIN_VALUE, intrinsicWidth: 1, intrinsicHeight: 1 }))])).toThrow("image fitted dimensions");
    expect(() => validateScenes([scene(fitNode({ fit: "none", scale: 1e-12 }))])).toThrow("image fitted dimensions");
  });

  it("requires optional transform scale to be finite, positive, and bounded", () => {
    for (const scale of [null, "1", 0, -1, Number.NaN, Number.POSITIVE_INFINITY, SCENE_LIMITS.maxDimension + 1]) {
      expect(() => validateScenes([scene(fitNode({ scale: scale as number }))])).toThrow("image.scale");
    }
  });

  it("requires a position object with both coordinate objects", () => {
    const position = imageNode().image!.position;
    for (const malformed of [null, [], "center", {}, { x: position.x }, { y: position.y }]) {
      expect(() => validateScenes([scene(fitNode({ position: malformed as unknown as SceneImageFit["position"] }))])).toThrow("image.position");
    }
    for (const axis of ["x", "y"] as const) {
      for (const malformed of [null, [], "50%"]) {
        expect(() => validateScenes([scene(fitNode({ position: { ...position, [axis]: malformed } as SceneImageFit["position"] }))])).toThrow(`image.position.${axis}`);
      }
    }
  });

  it("requires both finite bounded numbers on each position axis", () => {
    const position = imageNode().image!.position;
    for (const axis of ["x", "y"] as const) {
      for (const field of ["percentage", "offset"] as const) {
        for (const amount of [undefined, null, "0", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, SCENE_LIMITS.maxDimension + 1, -SCENE_LIMITS.maxDimension - 1]) {
          const malformed = { ...position, [axis]: { ...position[axis], [field]: amount } };
          expect(() => validateScenes([scene(fitNode({ position: malformed as unknown as SceneImageFit["position"] }))])).toThrow(`image.position.${axis}.${field}`);
        }
      }
    }
  });

  it("rejects cover geometry whose aspect ratio expands past the scene size limit", () => {
    const node = fitNode({ fit: "cover", intrinsicWidth: SCENE_LIMITS.maxDimension, intrinsicHeight: 1 });
    expect(() => validateScenes([scene(node)])).toThrow("image fitted geometry");
  });

  it("rejects natural-size geometry expanded past the scene size limit by a transform", () => {
    const node = fitNode({ fit: "none", intrinsicWidth: 1000, intrinsicHeight: 500, scale: 1000 });
    expect(() => validateScenes([scene(node)])).toThrow("image fitted geometry");
  });

  it("rejects bounded position fields that move the fitted object outside scene coordinate limits", () => {
    const node = fitNode({
      fit: "none", intrinsicWidth: 4000, intrinsicHeight: 100,
      position: { x: { percentage: -1, offset: 0 }, y: { percentage: 0, offset: 0 } }
    });
    node.rect = { x: SCENE_LIMITS.maxDimension - 1000, y: 0, width: 2000, height: 200 };
    expect(() => validateScenes([scene(node)])).toThrow("image fitted geometry");
  });

  it("validates fitted page coordinates after the node rotation", () => {
    const node = imageNode({ rotation: -90, rect: { x: SCENE_LIMITS.maxDimension - 10, y: 0, width: 200, height: 200 } });
    // The centered contain image has a 50px local y offset. Turning it -90°
    // moves that offset into positive page x, beyond the permitted coordinate.
    expect(() => validateScenes([scene(node)])).toThrow("image fitted geometry");
  });

  it("rejects tiny scales that would create non-finite or excessive SVG viewport dimensions", () => {
    for (const scale of [Number.MIN_VALUE, 1e-300, 0.0001]) {
      // Fill's fitted object is just 200×200, independent of intrinsic scale;
      // materializing an SVG also divides this frame by its transform scale.
      expect(() => validateScenes([scene(fitNode({ fit: "fill", scale }))])).toThrow("image");
    }
  });

  it("bounds both normalized SVG viewport axes", () => {
    for (const rect of [
      { x: 0, y: 0, width: SCENE_LIMITS.maxDimension, height: 1 },
      { x: 0, y: 0, width: 1, height: SCENE_LIMITS.maxDimension }
    ]) {
      const node = fitNode({ fit: "fill", scale: 0.5 });
      node.rect = rect;
      expect(() => validateScenes([scene(node)])).toThrow("image");
    }
  });
});
