import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type SceneBorder, type SceneBorders, type SceneDocument, type SceneNode, type ScenePaint } from "../shared/contracts";
import { ImportCancelledError, importScenes } from "./penpot";

type Point = [number, number];
type FakeShape = Record<string, unknown> & {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  children: FakeShape[];
  parent?: FakeShape;
  removed?: boolean;
  pluginData: Record<string, string>;
};

function detach(shape: FakeShape): void {
  if (!shape.parent) return;
  const siblings = shape.parent.children;
  const index = siblings.indexOf(shape);
  if (index >= 0) siblings.splice(index, 1);
  shape.parent = undefined;
}

function fakeShape(type: string): FakeShape {
  return {
    type, name: "", x: 0, y: 0, width: 0, height: 0, opacity: 1,
    fills: [], strokes: [], children: [], pluginData: {},
    resize: vi.fn(function (this: FakeShape, width: number, height: number) {
      this.width = width;
      this.height = height;
    }),
    appendChild: vi.fn(function (this: FakeShape, child: FakeShape) {
      detach(child);
      // Record topmost-first appends as the existing importer mock does.
      // The live host inserts at index zero, behind existing children.
      this.children.push(child);
      child.parent = this;
    }),
    setPluginData: vi.fn(function (this: FakeShape, key: string, value: string) { this.pluginData[key] = value; }),
    getPluginData: vi.fn(function (this: FakeShape, key: string) { return this.pluginData[key] || ""; }),
    remove: vi.fn(function (this: FakeShape) {
      this.removed = true;
      for (const child of [...this.children]) (child.remove as () => void)();
      detach(this);
    })
  };
}

function pathPoints(value: unknown): Point[] {
  if (typeof value !== "string") throw new Error("Expected an editable SVG path.");
  const numbers = (value.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || []).map(Number);
  if (numbers.length % 2) throw new Error(`Unexpected polygon path: ${value}`);
  return Array.from({ length: numbers.length / 2 }, (_, index) => [numbers[index * 2], numbers[index * 2 + 1]]);
}

function fakePath(throwOnD = false): FakeShape {
  const shape = fakeShape("path");
  let d = "";
  Object.defineProperty(shape, "d", {
    configurable: true,
    enumerable: true,
    get: () => d,
    set: (value: string) => {
      if (throwOnD) throw new Error("path conversion failed");
      d = value;
      const points = pathPoints(d);
      shape.x = Math.min(...points.map(([x]) => x));
      shape.y = Math.min(...points.map(([, y]) => y));
      shape.width = Math.max(...points.map(([x]) => x)) - shape.x;
      shape.height = Math.max(...points.map(([, y]) => y)) - shape.y;
    }
  });
  shape.resize = vi.fn(function (this: FakeShape, width: number, height: number) {
    // Resizing a real path changes its points. Model that behavior so a side
    // strip mistakenly resized to the full node rectangle cannot pass.
    const points = pathPoints(d);
    const minimumX = Math.min(...points.map(([x]) => x));
    const minimumY = Math.min(...points.map(([, y]) => y));
    const scaleX = this.width ? width / this.width : 1;
    const scaleY = this.height ? height / this.height : 1;
    d = points.map(([x, y], index) => `${index ? "L" : "M"} ${minimumX + (x - minimumX) * scaleX} ${minimumY + (y - minimumY) * scaleY}`).join(" ") + " Z";
    this.width = width;
    this.height = height;
  });
  return shape;
}

const border = (width = 0, color = "transparent", style = "solid"): SceneBorder => ({ width, color, style });
const borders = (values: Partial<SceneBorders>): SceneBorders => ({ top: border(), right: border(), bottom: border(), left: border(), ...values });

function node(id: string, kind: SceneNode["kind"], paint: ScenePaint = {}): SceneNode {
  return {
    id, parentId: "root", children: [], kind, name: id, source: `#${id}`,
    rect: { x: 20, y: 30, width: 100, height: 60 }, zIndex: 0, paint, layout: { kind: "none" }
  };
}

function textNode(parentId: string): SceneNode {
  return {
    ...node("label", "text", { color: "#111827", opacity: 1 }), parentId,
    rect: { x: 28, y: 38, width: 70, height: 20 }, text: "Editable text",
    textStyle: {
      fontFamily: "Inter", fontSize: 16, fontWeight: 400, fontStyle: "normal", lineHeight: 1.25,
      letterSpacing: 0, textAlign: "left", textDecoration: "none", textTransform: "none"
    }
  };
}

function scene(nodes: SceneNode[], rootPaint: ScenePaint = {}): SceneDocument {
  return {
    protocolVersion: PROTOCOL_VERSION, viewport: { id: "desktop", name: "Desktop", width: 400, height: 300 },
    documentSize: { width: 400, height: 300 }, assets: [], diagnostics: [],
    nodes: [
      { ...node("root", "container", rootPaint), parentId: undefined, source: "body", rect: { x: 0, y: 0, width: 400, height: 300 }, children: nodes.filter((value) => value.parentId === "root").map((value) => value.id) },
      ...nodes
    ]
  };
}

function sortedPoints(points: Point[]): Point[] {
  return points.map(([x, y]): Point => [x, y]).sort(([ax, ay], [bx, by]) => ax - bx || ay - by);
}

function expectPoints(shape: FakeShape, expected: Point[]): void {
  const points = pathPoints(shape.d);
  const minimumX = Math.min(...points.map(([x]) => x));
  const minimumY = Math.min(...points.map(([, y]) => y));
  expect(sortedPoints(points.map(([x, y]) => [shape.x + x - minimumX, shape.y + y - minimumY]))).toEqual(sortedPoints(expected));
}

describe("Penpot per-side borders", () => {
  let boards: FakeShape[];
  let paths: FakeShape[];
  let rectangles: FakeShape[];
  let groups: FakeShape[];
  let undoFinish: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    boards = [];
    paths = [];
    rectangles = [];
    groups = [];
    undoFinish = vi.fn();
    vi.stubGlobal("penpot", {
      viewport: { center: { x: 100, y: 200 } },
      history: { undoBlockBegin: vi.fn(() => Symbol("undo")), undoBlockFinish: undoFinish },
      createBoard: vi.fn(() => {
        const shape = Object.assign(fakeShape("board"), { clipContent: false, showInViewMode: true });
        boards.push(shape);
        return shape;
      }),
      createRectangle: vi.fn(() => {
        const shape = fakeShape("rectangle");
        rectangles.push(shape);
        return shape;
      }),
      createPath: vi.fn(() => {
        const shape = fakePath();
        paths.push(shape);
        return shape;
      }),
      createText: vi.fn((characters: string) => Object.assign(fakeShape("text"), { characters, growType: "fixed" })),
      group: vi.fn((members: FakeShape[]) => {
        const parent = members.find((shape) => shape.parent)?.parent;
        const shape = Object.assign(fakeShape("group"), { children: [...members] });
        for (const member of members) {
          detach(member);
          member.parent = shape;
          member.constraintsHorizontal = "scale";
          member.constraintsVertical = "scale";
        }
        if (parent) {
          parent.children.push(shape);
          shape.parent = parent;
        }
        groups.push(shape);
        return shape;
      }),
      createShapeFromSvg: vi.fn(() => null), createShapeFromSvgWithImages: vi.fn(),
      uploadMediaData: vi.fn().mockResolvedValue({ id: "media" }), uploadMediaUrl: vi.fn().mockResolvedValue({ id: "media" })
    });
  });

  const imported = async (input: SceneDocument): Promise<FakeShape> => {
    const [board] = await importScenes([input], { isCancelled: () => false, onProgress: vi.fn() });
    return board as unknown as FakeShape;
  };

  const side = (name: keyof SceneBorders): FakeShape => {
    const found = paths.find((shape) => shape.pluginData["border-side"] === name);
    if (!found) throw new Error(`Missing ${name} border layer.`);
    return found;
  };

  it("keeps a bottom-only decoration behind editable text and applies container opacity once", async () => {
    const card = node("card", "container", { borders: borders({ bottom: border(3, "#2563eb") }), opacity: 0.5 });
    card.children = ["label"];
    const board = await imported(scene([card, textNode(card.id)]));

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(board.children).toEqual([group]);
    expect(group).toMatchObject({ name: "card", opacity: 0.5, pluginData: { source: "#card" } });
    const bottom = side("bottom");
    const text = group.children.find((shape) => shape.type === "text");
    // The live host preserves sibling order when grouping, even when the
    // group's array asks for a different order. Its appends insert behind
    // existing siblings, so the backdrop must be appended after the border.
    const appends = (board.appendChild as ReturnType<typeof vi.fn>).mock.calls.map(([shape]) => shape);
    expect(appends).toEqual([text, bottom, rectangles[0]]);
    expect(group.children.indexOf(bottom)).toBeLessThan(group.children.indexOf(text!));
    expect(group.children.every((shape) => shape.opacity === 1)).toBe(true);
    expect(bottom).toMatchObject({ name: "card bottom border", width: 100, height: 3, fills: [{ fillColor: "#2563eb", fillOpacity: 1 }], strokes: [], constraintsHorizontal: "left", constraintsVertical: "top" });
    expectPoints(bottom, [[120, 287], [220, 287], [120, 290], [220, 290]]);
    expect(text).toMatchObject({ characters: "Editable text", x: 128, y: 238, opacity: 1 });
    expect(penpot.uploadMediaUrl).not.toHaveBeenCalled();
    expect(penpot.uploadMediaData).not.toHaveBeenCalled();
  });

  it("creates editable side polygons with unequal widths, diagonal joins, and separate color alpha", async () => {
    await imported(scene([node("box", "box", {
      backgroundColor: "#f8fafc",
      borders: borders({ top: border(4, "rgba(255, 0, 0, 0.25)"), right: border(8, "#00ff0080"), bottom: border(12, "rgb(0 0 255 / 75%)"), left: border(6, "#facc15") })
    })]));

    expect(paths).toHaveLength(4);
    expect(side("top").fills).toEqual([{ fillColor: "#ff0000", fillOpacity: 0.25 }]);
    expect(side("right").fills).toEqual([{ fillColor: "#00ff00", fillOpacity: 128 / 255 }]);
    expect(side("bottom").fills).toEqual([{ fillColor: "#0000ff", fillOpacity: 0.75 }]);
    expect(side("left").fills).toEqual([{ fillColor: "#facc15", fillOpacity: 1 }]);
    expectPoints(side("top"), [[120, 230], [220, 230], [212, 234], [126, 234]]);
    expectPoints(side("right"), [[220, 230], [220, 290], [212, 278], [212, 234]]);
    expectPoints(side("bottom"), [[220, 290], [120, 290], [126, 278], [212, 278]]);
    expectPoints(side("left"), [[120, 290], [120, 230], [126, 234], [126, 278]]);
    expect(paths.every((shape) => shape.opacity === 1 && (shape.strokes as unknown[]).length === 0)).toBe(true);
    expect(rectangles[0].strokes).toEqual([]);
    expect(penpot.uploadMediaUrl).not.toHaveBeenCalled();
    expect(penpot.uploadMediaData).not.toHaveBeenCalled();
  });

  it("composites image content and its border layers at the image opacity once", async () => {
    const image = { ...node("photo", "image", { borders: borders({ left: border(6, "rgba(255, 0, 0, .4)") }), opacity: 0.5 }), assetId: "photo" };
    const input = scene([image]);
    input.assets = [{ id: "photo", url: "https://example.test/photo.png", mimeType: "image/png" }];
    const board = await imported(input);

    expect(penpot.uploadMediaUrl).toHaveBeenCalledOnce();
    expect(paths).toHaveLength(1);
    expect(groups).toHaveLength(1);
    expect(board.children).toEqual([groups[0]]);
    expect(groups[0]).toMatchObject({ name: "photo", opacity: 0.5, pluginData: { source: "#photo" } });
    expect(groups[0].children).toEqual([rectangles[0], side("left")]);
    // Append the image behind its existing border path before grouping;
    // reordering the group arguments alone does not move live siblings.
    const appends = (board.appendChild as ReturnType<typeof vi.fn>).mock.calls.map(([shape]) => shape);
    expect(appends).toEqual([side("left"), rectangles[0]]);
    expect(rectangles[0]).toMatchObject({ opacity: 1, fills: [{ fillImage: { id: "media" }, fillOpacity: 1 }] });
    expect(side("left")).toMatchObject({ opacity: 1, fills: [{ fillColor: "#ff0000", fillOpacity: 0.4 }] });
  });

  it("appends root and clipping borders behind descendants without growing either board", async () => {
    const clip = node("clip", "container", { borders: borders({ left: border(5, "#2563eb") }), overflow: "hidden", opacity: 0.4 });
    clip.children = ["label"];
    const text = textNode(clip.id);
    text.rect = { x: 10, y: 10, width: 600, height: 24 };
    const board = await imported(scene([clip, text], { borders: borders({ bottom: border(7, "#dc2626") }), opacity: 0.5 }));

    expect(boards).toHaveLength(3);
    const nested = boards[1];
    const contentClip = boards[2];
    expect(board).toMatchObject({ width: 400, height: 300, opacity: 0.5, clipContent: true });
    expect(nested).toMatchObject({ x: 120, y: 230, width: 100, height: 60, opacity: 0.4, clipContent: true, horizontalSizing: "fix", verticalSizing: "fix" });
    expect(nested.children.map((shape) => shape.type)).toEqual(["board", "path"]);
    expect(contentClip).toMatchObject({ x: 125, y: 230, width: 95, height: 60, opacity: 1, clipContent: true, pluginData: { "border-content-clip": "true" } });
    expect(contentClip.children).toHaveLength(1);
    expect(contentClip.children[0]).toMatchObject({ type: "text", x: 110, y: 210, width: 600, height: 24, opacity: 1 });
    expect(board.children.map((shape) => shape.type)).toEqual(["board", "path"]);
    expect(nested.children.every((shape) => shape.opacity === 1)).toBe(true);
    expect(side("bottom")).toMatchObject({ x: 100, y: 493, width: 400, height: 7, opacity: 1 });
    expect(side("left")).toMatchObject({ x: 120, y: 230, width: 5, height: 60, opacity: 1 });
    expect(groups).toHaveLength(0);
  });

  it("uses already-scaled side widths and rotates each side offset with its node", async () => {
    const rotated = node("rotated", "box", { borders: borders({ left: border(12, "#2563eb"), bottom: border(6, "#dc2626") }) });
    rotated.rect = { x: 40, y: 50, width: 180, height: 100 };
    rotated.rotation = 30;
    await imported(scene([rotated]));

    const bottom = side("bottom");
    const left = side("left");
    expect(bottom).toMatchObject({ width: 180, height: 6, rotation: 30 });
    expect(left).toMatchObject({ width: 12, height: 100, rotation: 30 });
    expect(bottom.x).toBeCloseTo(140 - 100 * Math.sin(Math.PI / 6));
    expect(bottom.y).toBeCloseTo(250 + 94 * Math.cos(Math.PI / 6));
    expect(left.x).toBeCloseTo(140 - 100 * Math.sin(Math.PI / 6));
    expect(left.y).toBeCloseTo(250);
    expect(sortedPoints(pathPoints(bottom.d))).toEqual(sortedPoints([[180, 6], [0, 6], [12, 0], [180, 0]]));
  });

  it("preserves scaled side widths smaller than the generic shape minimum", async () => {
    await imported(scene([node("thin", "box", { borders: borders({ left: border(0.01, "#2563eb"), bottom: border(0.01, "#dc2626") }) })]));

    const bottom = side("bottom");
    const left = side("left");
    expect(paths).toHaveLength(2);
    expect(bottom.width).toBe(100);
    expect(bottom.height).toBeCloseTo(0.01, 10);
    expect(bottom.x).toBe(120);
    expect(bottom.y).toBeCloseTo(289.99, 10);
    expect(left.width).toBeCloseTo(0.01, 10);
    expect(left.height).toBe(60);
    expect(left.x).toBe(120);
    expect(left.y).toBe(230);
    const bottomYs = pathPoints(bottom.d).map(([, y]) => y);
    const leftXs = pathPoints(left.d).map(([x]) => x);
    expect(Math.max(...bottomYs) - Math.min(...bottomYs)).toBeCloseTo(0.01, 10);
    expect(Math.max(...leftXs) - Math.min(...leftXs)).toBeCloseTo(0.01, 10);
  });

  it("reserves transparent and unsupported sides in the joins while omitting their paint", async () => {
    await imported(scene([node("reserved", "box", {
      borders: borders({ top: border(4, "#ff0000", "double"), right: border(8, "rgba(0, 255, 0, 0)"), bottom: border(12, "#0000ff"), left: border(6, "#facc15") })
    })]));

    expect(paths.map((shape) => shape.pluginData["border-side"]).sort()).toEqual(["bottom", "left"]);
    expectPoints(side("bottom"), [[220, 290], [120, 290], [126, 278], [212, 278]]);
    expectPoints(side("left"), [[120, 290], [120, 230], [126, 234], [126, 278]]);
    expect(rectangles[0].strokes).toEqual([]);
  });

  it("bounds opposing border widths to the box without crossing the inner joins", async () => {
    const narrow = node("narrow", "box", {
      borders: borders({ top: border(20, "#ff0000"), right: border(30, "#00ff00"), bottom: border(30, "#0000ff"), left: border(10, "#facc15") })
    });
    narrow.rect = { x: 20, y: 30, width: 20, height: 10 };
    await imported(scene([narrow]));

    expect(paths).toHaveLength(4);
    // Horizontal widths halve and vertical widths shrink to a fifth. The
    // interior collapses to (5, 4), retaining each side's width ratio.
    expectPoints(side("top"), [[120, 230], [140, 230], [125, 234], [125, 234]]);
    expectPoints(side("right"), [[140, 230], [140, 240], [125, 234], [125, 234]]);
    expectPoints(side("bottom"), [[140, 240], [120, 240], [125, 234], [125, 234]]);
    expectPoints(side("left"), [[120, 240], [120, 230], [125, 234], [125, 234]]);
  });

  it("omits rounded asymmetric borders instead of falling back to a full legacy stroke", async () => {
    const board = await imported(scene([node("rounded", "box", {
      backgroundColor: "#ffffff", radius: [8, 8, 8, 8], borders: borders({ bottom: border(3, "#2563eb") }),
      borderColor: "#2563eb", borderWidth: 3, borderStyle: "solid"
    })]));

    expect(paths).toHaveLength(0);
    expect(groups).toHaveLength(0);
    expect(board.children[0]).toMatchObject({ fills: [{ fillColor: "#ffffff", fillOpacity: 1 }], strokes: [], borderRadiusTopLeft: 8 });
  });

  it.each(["solid", "dashed", "dotted"])("keeps legacy uniform %s borders as an inner native stroke", async (style) => {
    const board = await imported(scene([], { borderColor: "rgba(10, 20, 30, .5)", borderWidth: 4, borderStyle: style, radius: [8, 8, 8, 8] }));

    expect(board.strokes).toEqual([{ strokeColor: "#0a141e", strokeOpacity: 0.5, strokeWidth: 4, strokeStyle: style, strokeAlignment: "inner" }]);
    expect(paths).toHaveLength(0);
    expect(board).toMatchObject({ borderRadiusTopLeft: 8 });
  });

  it("defaults older uniform border data without a style to a solid inner stroke", async () => {
    const board = await imported(scene([], { borderColor: "#2563eb", borderWidth: 3 }));

    expect(board.strokes).toEqual([{ strokeColor: "#2563eb", strokeOpacity: 1, strokeWidth: 3, strokeStyle: "solid", strokeAlignment: "inner" }]);
    expect(paths).toHaveLength(0);
  });

  it("uses a native stroke when explicit side data is uniform", async () => {
    const uniform = border(2, "#12345680", "dashed");
    const board = await imported(scene([], { borders: { top: uniform, right: uniform, bottom: uniform, left: uniform } }));

    expect(board.strokes).toEqual([{ strokeColor: "#123456", strokeOpacity: 128 / 255, strokeWidth: 2, strokeStyle: "dashed", strokeAlignment: "inner" }]);
    expect(paths).toHaveLength(0);
  });

  it("omits unsupported uniform border styles instead of painting solid", async () => {
    const board = await imported(scene([], { borderColor: "#2563eb", borderWidth: 4, borderStyle: "double" }));
    expect(board.strokes).toEqual([]);
    expect(paths).toHaveLength(0);
  });

  it("rolls back a bordered container when the host cannot create its compositing group", async () => {
    (penpot.group as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
    const card = node("ungroupable", "container", { borders: borders({ bottom: border(3, "#2563eb") }), opacity: 0.5 });
    card.children = ["label"];

    await expect(importScenes([scene([card, textNode(card.id)])], { isCancelled: () => false, onProgress: vi.fn() })).rejects.toThrow("Penpot could not group the container and its side borders.");
    expect(penpot.group).toHaveBeenCalledOnce();
    expect(paths).toHaveLength(1);
    expect(paths[0].removed).toBe(true);
    expect(rectangles.every((shape) => shape.removed)).toBe(true);
    expect(boards[0].removed).toBe(true);
    expect(undoFinish).toHaveBeenCalledOnce();
  });

  it("rolls back attached and unattached border paths when creating a later path fails", async () => {
    (penpot.createPath as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const shape = fakePath(paths.length === 1);
      paths.push(shape);
      return shape;
    });
    const input = scene([node("broken", "box", { borders: borders({ top: border(4, "#ff0000"), bottom: border(8, "#0000ff") }) })]);

    await expect(importScenes([input], { isCancelled: () => false, onProgress: vi.fn() })).rejects.toThrow("path conversion failed");
    expect(paths).toHaveLength(2);
    expect(paths.every((shape) => shape.removed)).toBe(true);
    expect(boards[0].removed).toBe(true);
    expect(undoFinish).toHaveBeenCalledOnce();
  });

  it("removes border layers along with the partial board when cancellation arrives during creation", async () => {
    let cancelled = false;
    (penpot.createPath as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const shape = fakePath();
      paths.push(shape);
      cancelled = true;
      return shape;
    });
    const input = scene([node("cancelled", "box", { borders: borders({ bottom: border(3, "#2563eb") }) })]);

    await expect(importScenes([input], { isCancelled: () => cancelled, onProgress: vi.fn() })).rejects.toBeInstanceOf(ImportCancelledError);
    expect(paths).toHaveLength(1);
    expect(paths[0].removed).toBe(true);
    expect(boards[0].removed).toBe(true);
    expect(undoFinish).toHaveBeenCalledOnce();
  });
});
