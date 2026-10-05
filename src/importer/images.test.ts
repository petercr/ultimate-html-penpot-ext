import { describe, expect, it } from "vitest";
import type { SceneBorder, SceneNode } from "../shared/contracts";
import { imageGeometry } from "../shared/images";

function imageNode(image: Partial<NonNullable<SceneNode["image"]>> = {}, overrides: Partial<SceneNode> = {}): SceneNode {
  return {
    id: "image", children: [], kind: "image", name: "Photo", source: "#photo", zIndex: 0,
    rect: { x: 20, y: 30, width: 200, height: 200 }, paint: {}, layout: { kind: "none" },
    image: {
      fit: "contain", position: { x: { percentage: 0.5, offset: 0 }, y: { percentage: 0.5, offset: 0 } },
      intrinsicWidth: 400, intrinsicHeight: 200, ...image
    }, ...overrides
  };
}

describe("image geometry", () => {
  it.each([
    ["fill", { x: 0, y: 0, width: 200, height: 200 }],
    ["contain", { x: 0, y: 50, width: 200, height: 100 }],
    ["cover", { x: -100, y: 0, width: 400, height: 200 }],
    ["none", { x: -100, y: 0, width: 400, height: 200 }],
    ["scale-down", { x: 0, y: 50, width: 200, height: 100 }]
  ] as const)("resolves %s inside the captured content box", (fit, object) => {
    expect(imageGeometry(imageNode({ fit }))).toEqual({ content: { x: 0, y: 0, width: 200, height: 200 }, object });
  });

  it("keeps small natural images at their natural size for scale-down", () => {
    expect(imageGeometry(imageNode({ fit: "scale-down", intrinsicWidth: 80, intrinsicHeight: 40 }))?.object).toEqual({ x: 60, y: 80, width: 80, height: 40 });
    expect(imageGeometry(imageNode({ fit: "contain", intrinsicWidth: 80, intrinsicHeight: 40 }))?.object).toEqual({ x: 0, y: 50, width: 200, height: 100 });
  });

  it("positions percentages against remaining space, including negative cover space", () => {
    const position = { x: { percentage: 0.75, offset: 12 }, y: { percentage: -0.25, offset: -6 } };
    expect(imageGeometry(imageNode({ fit: "cover", position }))?.object).toEqual({ x: -138, y: -6, width: 400, height: 200 });
    expect(imageGeometry(imageNode({ fit: "contain", position }))?.object).toEqual({ x: 12, y: -31, width: 200, height: 100 });
  });

  it("insets the content by all effective border sides and padding", () => {
    const border = (width: number, style = "solid"): SceneBorder => ({ color: "#123456", width, style });
    const node = imageNode({}, {
      rect: { x: 20, y: 30, width: 200, height: 120 },
      paint: { borders: { top: border(2), right: border(4), bottom: border(6), left: border(30, "hidden") } },
      layout: { kind: "none", padding: [8, 16, 4, 10] }
    });
    expect(imageGeometry(node)).toEqual({
      content: { x: 10, y: 10, width: 170, height: 100 },
      object: { x: 10, y: 17.5, width: 170, height: 85 }
    });
  });

  it("uses natural CSS dimensions scaled with the captured frame", () => {
    const node = imageNode({ fit: "none", intrinsicWidth: 80, intrinsicHeight: 40, scale: 2,
      position: { x: { percentage: 1, offset: -8 }, y: { percentage: 0, offset: 12 } }
    }, { rect: { x: 20, y: 30, width: 400, height: 200 }, layout: { kind: "none", padding: [10, 10, 10, 10] }, paint: { borderWidth: 4, borderStyle: "solid" } });
    expect(imageGeometry(node)).toEqual({
      content: { x: 14, y: 14, width: 372, height: 172 },
      object: { x: 218, y: 26, width: 160, height: 80 }
    });
  });

  it("keeps image rectangles local when the node has a composed rotation", () => {
    const node = imageNode({ fit: "contain" }, { rotation: 75, rect: { x: 200, y: 350, width: 200, height: 200 } });
    expect(imageGeometry(node)).toEqual(imageGeometry(imageNode()));
  });

  it("preserves positive subpixel image dimensions", () => {
    const object = imageGeometry(imageNode({ fit: "none", intrinsicWidth: 1, intrinsicHeight: 2, scale: 0.01 },
      { rect: { x: 0, y: 0, width: 0.2, height: 0.2 } }))!.object;
    expect(object).toMatchObject({ x: 0.095, width: 0.01, height: 0.02 });
    expect(object.y).toBeCloseTo(0.09, 12);
  });

  it("returns empty geometry for empty boxes and bounds opposing insets", () => {
    expect(imageGeometry(imageNode({}, { rect: { x: 20, y: 30, width: 0, height: 0 } }))).toEqual({ content: { x: 0, y: 0, width: 0, height: 0 }, object: { x: 0, y: 0, width: 0, height: 0 } });
    expect(imageGeometry(imageNode({}, { rect: { x: 0, y: 0, width: 10, height: 10 }, layout: { kind: "none", padding: [20, 30, 20, 10] } }))).toEqual({ content: { x: 2.5, y: 5, width: 0, height: 0 }, object: { x: 2.5, y: 5, width: 0, height: 0 } });
    expect(imageGeometry(imageNode({}, { rect: { x: 0, y: 0, width: 10, height: 0 } }))?.object).toMatchObject({ width: 0, height: 0 });
  });

  it("skips unavailable natural sizes for fits that need an aspect ratio", () => {
    expect(imageGeometry(imageNode({ fit: "contain", intrinsicWidth: 0 }))?.object).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(imageGeometry(imageNode({ fit: "fill", intrinsicWidth: 0 }))?.object).toEqual({ x: 0, y: 0, width: 200, height: 200 });
  });

  it("leaves older image nodes without fit metadata on their legacy path", () => {
    expect(imageGeometry(imageNode({}, { image: undefined }))).toBeUndefined();
  });
});
