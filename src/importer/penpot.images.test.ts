import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type SceneDocument, type SceneImageFit, type SceneNode } from "../shared/contracts";
import { ImportCancelledError, importScenes, rotatedBoundsOrigin } from "./penpot";
import { validateScenes } from "../shared/validation";

type FakeShape = Record<string, unknown> & {
  type: string; x: number; y: number; width: number; height: number;
  children: FakeShape[]; parent?: FakeShape; removed?: boolean; pluginData: Record<string, string>;
};
function shape(type: string): FakeShape {
  return { type, name: "", x: 0, y: 0, width: 0, height: 0, opacity: 1, rotation: 0,
    fills: [], strokes: [], children: [], pluginData: {},
    resize: vi.fn(function (this: FakeShape, width: number, height: number) { this.width = width; this.height = height; }),
    appendChild: vi.fn(function (this: FakeShape, child: FakeShape) { this.children.unshift(child); child.parent = this; }),
    setPluginData: vi.fn(function (this: FakeShape, key: string, value: string) { this.pluginData[key] = value; }),
    getPluginData: vi.fn(function (this: FakeShape, key: string) { return this.pluginData[key] ?? ""; }),
    remove: vi.fn(function (this: FakeShape) { this.removed = true; this.children.forEach((child) => (child.remove as () => void)()); })
  };
}
const centered = { x: { percentage: 0.5, offset: 0 }, y: { percentage: 0.5, offset: 0 } };
function image(image: Partial<SceneImageFit> = {}, overrides: Partial<SceneNode> = {}): SceneNode {
  return { id: "photo", children: [], kind: "image", name: "Photo", source: "#photo", zIndex: 0,
    rect: { x: 20, y: 30, width: 200, height: 200 }, paint: {}, layout: { kind: "none" }, assetId: "source",
    image: { fit: "contain", position: centered, intrinsicWidth: 400, intrinsicHeight: 200, ...image }, ...overrides };
}
function scene(nodes = [image()]): SceneDocument {
  return { protocolVersion: PROTOCOL_VERSION, viewport: { id: "desktop", name: "Desktop", width: 400, height: 600 },
    documentSize: { width: 400, height: 600 }, nodes, diagnostics: [],
    assets: [{ id: "source", url: "https://example.test/photo.png", mimeType: "image/png" }] };
}
function descendants(value: FakeShape): FakeShape[] { return value.children.flatMap((child) => [child, ...descendants(child)]); }
const tagged = (board: FakeShape, key: string) => descendants(board).find((value) => value.pluginData[key] === "true")!;

describe("Penpot fitted images", () => {
  let boards: FakeShape[], rectangles: FakeShape[], paths: FakeShape[];
  beforeEach(() => {
    boards = []; rectangles = []; paths = [];
    vi.stubGlobal("penpot", {
      viewport: { center: { x: 100, y: 200 } },
      history: { undoBlockBegin: vi.fn(() => Symbol("undo")), undoBlockFinish: vi.fn() },
      createBoard: vi.fn(() => { const value = shape("board"); boards.push(value); return value; }),
      createRectangle: vi.fn(() => { const value = shape("rectangle"); rectangles.push(value); return value; }),
      createPath: vi.fn(() => { const value = shape("path"); paths.push(value); return value; }),
      createShapeFromSvgWithImages: vi.fn(), createShapeFromSvg: vi.fn(), group: vi.fn(),
      uploadMediaUrl: vi.fn().mockResolvedValue({ id: "media", width: 400, height: 200 }),
      uploadMediaData: vi.fn().mockResolvedValue({ id: "svg-media", width: 200, height: 200 })
    });
  });
  const imported = async (input = scene(), options = {}) => (await importScenes([input],
    { isCancelled: () => false, onProgress: vi.fn(), ...options }))[0] as unknown as FakeShape;

  it.each([
    ["fill", 120, 230, 200, 200], ["contain", 120, 280, 200, 100],
    ["cover", 20, 230, 400, 200], ["none", 20, 230, 400, 200], ["scale-down", 120, 280, 200, 100]
  ] as const)("imports %s as a native image rectangle inside fixed clip boards", async (fit, x, y, width, height) => {
    const board = await imported(scene([image({ fit })]));
    const frame = tagged(board, "image-clip"), clip = tagged(board, "image-content-clip"), content = tagged(board, "image-content");
    expect(frame).toMatchObject({ type: "board", x: 120, y: 230, width: 200, height: 200, clipContent: true, horizontalSizing: "fix", verticalSizing: "fix" });
    expect(clip).toMatchObject({ type: "board", parent: frame, x: 120, y: 230, width: 200, height: 200, fills: [], strokes: [], clipContent: true });
    expect(content).toMatchObject({ type: "rectangle", parent: clip, x, y, width, height, opacity: 1, strokes: [],
      fills: [{ fillOpacity: 1, fillImage: { id: "media", keepAspectRatio: false } }] });
    expect(content.constraintsHorizontal).toBe("left");
    expect(penpot.createShapeFromSvg).not.toHaveBeenCalled();
  });

  it("clips pixel and negative percentage positions against the content box", async () => {
    const board = await imported(scene([image({ fit: "cover", position: { x: { percentage: 0.25, offset: 12 }, y: { percentage: 0.75, offset: -8 } } })]));
    expect(tagged(board, "image-content")).toMatchObject({ x: 82, y: 222, width: 400, height: 200 });
    expect(tagged(board, "image-content-clip")).toMatchObject({ x: 120, y: 230, width: 200, height: 200 });
  });

  it("keeps padding, border, background, and element opacity on separate surfaces", async () => {
    const board = await imported(scene([image({ position: { x: { percentage: 0, offset: 0 }, y: { percentage: 0, offset: 0 } } }, {
      rect: { x: 20, y: 30, width: 240, height: 152 },
      paint: { backgroundColor: "#e9d5ff", borderColor: "#7c3aed", borderWidth: 4, borderStyle: "solid", opacity: 0.7 },
      layout: { kind: "none", padding: [12, 20, 12, 20] }
    })]));
    expect(tagged(board, "image-clip")).toMatchObject({ width: 240, height: 152, opacity: 0.7,
      fills: [{ fillColor: "#e9d5ff", fillOpacity: 1 }], strokes: [{ strokeColor: "#7c3aed", strokeWidth: 4 }] });
    expect(tagged(board, "image-content-clip")).toMatchObject({ x: 144, y: 246, width: 192, height: 120, opacity: 1 });
    expect(tagged(board, "image-content")).toMatchObject({ x: 144, y: 246, width: 192, height: 96, opacity: 1, fills: [{ fillImage: expect.any(Object) }] });
  });

  it("keeps square per-side paths above the image clip", async () => {
    const side = (width: number) => ({ width, color: "#123456", style: "solid" });
    const board = await imported(scene([image({}, { paint: { borders: { top: side(2), right: side(4), bottom: side(6), left: side(8) }, opacity: 0.5 } })]));
    const frame = tagged(board, "image-clip");
    expect(paths).toHaveLength(4);
    expect(frame.children[0]).toBe(tagged(board, "image-content-clip"));
    expect(frame.children.slice(1).every((child) => Boolean(child.pluginData["border-side"]))).toBe(true);
    expect(frame.opacity).toBe(0.5);
    expect(paths.every((path) => path.opacity === 1)).toBe(true);
    expect(tagged(board, "image-content-clip")).toMatchObject({ x: 128, y: 232, width: 188, height: 192 });
  });

  it("rotates each clipping and image frame at creation before an upload settles", async () => {
    let finishUpload!: (value: Awaited<ReturnType<typeof penpot.uploadMediaUrl>>) => void;
    vi.mocked(penpot.uploadMediaUrl).mockImplementation(() => new Promise((resolve) => { finishUpload = resolve; }));
    const importing = imported(scene([image({ position: { x: { percentage: 0, offset: 0 }, y: { percentage: 0, offset: 0 } } }, {
      rotation: 90, rect: { x: 20, y: 30, width: 200, height: 200 }, layout: { kind: "none", padding: [10, 10, 10, 10] }
    })]));
    await vi.waitFor(() => expect(rectangles).toHaveLength(1));
    const frame = tagged(boards[0], "image-clip"), clip = tagged(boards[0], "image-content-clip"), content = rectangles[0];
    const expected = rotatedBoundsOrigin({ x: 110, y: 240 }, 180, 90, 90);
    expect(content.x).toBeCloseTo(expected.x, 8); expect(content.y).toBeCloseTo(expected.y, 8);
    expect([frame.rotation, clip.rotation, content.rotation]).toEqual([90, 90, 90]);
    expect(content.fills).toEqual([]);
    finishUpload({ id: "media", width: 400, height: 200, data: async () => new Uint8Array() });
    await importing;
  });

  it("scales none using natural dimensions and the composed transform scale", async () => {
    const board = await imported(scene([image({ fit: "none", intrinsicWidth: 80, intrinsicHeight: 40, scale: 2 })]));
    expect(tagged(board, "image-content")).toMatchObject({ x: 140, y: 290, width: 160, height: 80 });
  });

  it("uses a reduced circular radius for uniformly inset rounded content", async () => {
    const board = await imported(scene([image({ fit: "cover" }, { paint: { radius: [20, 24, 20, 24], borderWidth: 4, borderStyle: "solid" }, layout: { kind: "none", padding: [6, 6, 6, 6] } })]));
    expect(tagged(board, "image-content-clip")).toMatchObject({ borderRadiusTopLeft: 10, borderRadiusTopRight: 14, borderRadiusBottomRight: 10, borderRadiusBottomLeft: 14 });
  });

  it("reports elliptical inner corners while retaining the outer rounded clip", async () => {
    const onDiagnostic = vi.fn();
    const board = await imported(scene([image({}, { paint: { radius: [20, 20, 20, 20] }, layout: { kind: "none", padding: [6, 10, 6, 10] } })]), { onDiagnostic });
    expect(tagged(board, "image-clip")).toMatchObject({ borderRadiusTopLeft: 20 });
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: "UNSUPPORTED_IMAGE_RADIUS", source: "#photo" }));
  });

  it("keeps an empty content box as decoration without creating image or clip layers", async () => {
    const board = await imported(scene([image({}, { rect: { x: 20, y: 30, width: 20, height: 20 }, layout: { kind: "none", padding: [10, 10, 10, 10] } })]));
    expect(tagged(board, "image-clip")).toMatchObject({ width: 20, height: 20 });
    expect(rectangles).toHaveLength(0); expect(boards).toHaveLength(2);
    expect(penpot.uploadMediaUrl).not.toHaveBeenCalled();
    expect(descendants(board).some((value) => value.pluginData["image-content-clip"])).toBe(false);
  });

  it("deduplicates reused raster uploads across different fit modes and viewports", async () => {
    const second = { ...scene([image({ fit: "cover" })]), viewport: { id: "mobile", name: "Mobile", width: 390, height: 600 } };
    await importScenes([scene(), second], { isCancelled: () => false, onProgress: vi.fn() });
    expect(penpot.uploadMediaUrl).toHaveBeenCalledTimes(1);
    expect(rectangles).toHaveLength(2);
  });

  it("materializes a SVG viewport for fill without distorting its internal aspect rule", async () => {
    const input = scene([image({ fit: "fill", intrinsicWidth: 160, intrinsicHeight: 112 })]);
    input.assets = [{ id: "source", dataUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" aria-label="a > b" style="width:160px;height:112px" width="160" height="112" viewBox="0 0 160 112"><circle cx="80" cy="56" r="20"/></svg>') }];
    const board = await imported(input);
    const call = (penpot.uploadMediaData as ReturnType<typeof vi.fn>).mock.calls[0];
    const svg = new TextDecoder().decode(call[1]);
    expect(svg).toContain('width="200" height="200"');
    expect(svg).toContain('viewBox="0 0 160 112"');
    expect(svg).toContain('aria-label="a > b"');
    expect(svg).toContain("width:200px!important;height:200px!important");
    expect(tagged(board, "image-content")).toMatchObject({ width: 200, height: 200, fills: [{ fillImage: { id: "svg-media", keepAspectRatio: false } }] });
    expect(penpot.createShapeFromSvgWithImages).not.toHaveBeenCalled();
  });

  it("uploads an SVG image fallback when its editable frame would underflow", async () => {
    const input = scene([image({ fit: "fill" })]);
    input.assets = [{ id: "source", dataUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 0.000001 100000"><rect width="0.000001" height="100000"/></svg>') }];
    const board = await imported(input);
    expect(penpot.createShapeFromSvgWithImages).not.toHaveBeenCalled();
    expect(penpot.createShapeFromSvg).not.toHaveBeenCalled();
    expect(penpot.uploadMediaData).toHaveBeenCalledTimes(1);
    expect(tagged(board, "image-content")).toMatchObject({ type: "rectangle", width: 200, height: 200,
      fills: [{ fillImage: { id: "svg-media", keepAspectRatio: false } }] });
    expect(tagged(board, "image-clip").pluginData["asset-fallback"]).toContain("SVG vector conversion could not retain the source viewport");
  });

  it("retains an editable SVG group in its aspect-correct object viewport", async () => {
    const vector = Object.assign(shape("group"), { width: 160, height: 112, opacity: 0.6 });
    vi.mocked(penpot.createShapeFromSvgWithImages).mockResolvedValue(vector as never);
    const input = scene([image({ fit: "fill", intrinsicWidth: 160, intrinsicHeight: 112 }, {
      rect: { x: 20, y: 30, width: 220, height: 124 }, paint: { opacity: 0.7 }
    })]);
    input.assets = [{ id: "source", dataUrl: "data:image/svg+xml," + encodeURIComponent('<svg width="160" height="112" viewBox="0 0 160 112"><rect width="160" height="112"/></svg>') }];
    const board = await imported(input);
    const viewport = tagged(board, "image-svg-viewport");
    expect(viewport).toMatchObject({ x: 120, y: 230, width: 220, height: 124, clipContent: true });
    expect(vector.parent).toBe(viewport);
    expect(vector.width).toBeCloseTo(160 * 124 / 112, 8);
    expect(vector.x).toBeCloseTo(120 + (220 - vector.width) / 2, 8);
    expect(vector).toMatchObject({ y: 230, height: 124, opacity: 0.6, pluginData: { "image-content": "true", "image-svg-vector": "true" } });
    expect(tagged(board, "image-clip").opacity).toBe(0.7);
    expect(penpot.uploadMediaData).not.toHaveBeenCalled();
  });

  it("removes a converted SVG with mismatching bounds before its image fallback", async () => {
    const vector = Object.assign(shape("group"), { width: 120, height: 80 });
    vi.mocked(penpot.createShapeFromSvgWithImages).mockResolvedValue(vector as never);
    const input = scene([image({ intrinsicWidth: 160, intrinsicHeight: 112 })]);
    input.assets = [{ id: "source", dataUrl: "data:image/svg+xml," + encodeURIComponent('<svg width="160" height="112" viewBox="0 0 160 112"><rect width="120" height="80"/></svg>') }];
    const onDiagnostic = vi.fn();
    const board = await imported(input, { onDiagnostic });
    expect(vector.removed).toBe(true);
    expect(tagged(board, "image-content").type).toBe("rectangle");
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: "ASSET_IMPORT_FAILED", message: expect.stringContaining("source viewport") }));
    expect(penpot.uploadMediaData).toHaveBeenCalledTimes(1);
  });

  it("reports SVG source URLs whose viewport could not be inlined", async () => {
    const input = scene([image({ fit: "fill", intrinsicWidth: 160, intrinsicHeight: 112 })]);
    input.assets = [{ id: "source", url: "https://example.test/source.svg", mimeType: "image/svg+xml" }];
    const onDiagnostic = vi.fn();
    await imported(input, { onDiagnostic });
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: "UNSUPPORTED_SVG_VIEWPORT", source: "#photo" }));
  });

  it("deduplicates SVGs with the same resolved source viewport", async () => {
    const input = scene([image({ fit: "fill", intrinsicWidth: 160, intrinsicHeight: 112 }), image({ fit: "fill", intrinsicWidth: 160, intrinsicHeight: 112 }, { id: "other", source: "#other", rect: { x: 0, y: 0, width: 200, height: 200 } })]);
    input.assets = [{ id: "source", dataUrl: 'data:image/svg+xml,' + encodeURIComponent('<svg width="160" height="112" viewBox="0 0 160 112"><rect width="160" height="112"/></svg>') }];
    await imported(input);
    expect(penpot.uploadMediaData).toHaveBeenCalledTimes(1);
  });

  it("keeps failed assets named, diagnosed, and cached across responsive boards", async () => {
    vi.mocked(penpot.uploadMediaUrl).mockRejectedValue(new Error("Upload rejected"));
    const onDiagnostic = vi.fn();
    const second = { ...scene(), viewport: { id: "mobile", name: "Mobile", width: 390, height: 600 } };
    const imported = await importScenes([scene(), second], { isCancelled: () => false, onProgress: vi.fn(), onDiagnostic });
    for (const board of imported) expect(tagged(board as unknown as FakeShape, "image-clip")).toMatchObject({ name: "Image unavailable: Photo", pluginData: { "asset-fallback": expect.stringContaining("Upload rejected") } });
    expect(penpot.uploadMediaUrl).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
  });

  it("rolls back clipped images and waits for an in-flight upload when cancelled", async () => {
    let resolveUpload!: (value: Awaited<ReturnType<typeof penpot.uploadMediaUrl>>) => void;
    vi.mocked(penpot.uploadMediaUrl).mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    let cancelled = false;
    const importing = importScenes([scene()], { isCancelled: () => cancelled, onProgress: vi.fn() });
    await vi.waitFor(() => expect(rectangles).toHaveLength(1));
    cancelled = true;
    let settled = false; void importing.catch(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    resolveUpload({ id: "media", width: 400, height: 200, data: async () => new Uint8Array() });
    await expect(importing).rejects.toBeInstanceOf(ImportCancelledError);
    expect(boards.every((board) => board.removed)).toBe(true);
    expect(rectangles.every((rectangle) => rectangle.removed)).toBe(true);
    expect(penpot.history.undoBlockFinish).toHaveBeenCalledTimes(1);
  });

  it("validates malformed image fields before any host mutations", () => {
    const input = scene([image({ intrinsicWidth: Number.NaN })]);
    expect(() => validateScenes([input])).toThrow("image.intrinsicWidth");
    expect(penpot.createBoard).not.toHaveBeenCalled();
  });
});
