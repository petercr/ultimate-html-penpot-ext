import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type SceneDocument } from "../shared/contracts";
import { ImportCancelledError, importScenes } from "./penpot";

type FakeShape = Record<string, unknown> & { type: string; children?: FakeShape[]; removed?: boolean };

function fakeShape(type: string): FakeShape {
  return {
    type,
    name: "",
    x: 0,
    y: 0,
    opacity: 1,
    strokes: [],
    children: [],
    pluginData: {},
    resize: vi.fn(),
    setPluginData: vi.fn(function (this: FakeShape, key: string, value: string) { (this.pluginData as Record<string, string>)[key] = value; }),
    getPluginData: vi.fn(function (this: FakeShape, key: string) { return String((this.pluginData as Record<string, string>)[key] || ""); }),
    appendChild: vi.fn(function (this: FakeShape, child: FakeShape) { this.children?.push(child); }),
    remove: vi.fn(function (this: FakeShape) { this.removed = true; })
  };
}

function scene(name = "Desktop"): SceneDocument {
  return {
    protocolVersion: PROTOCOL_VERSION,
    viewport: { id: name.toLowerCase(), name, width: 400, height: 300 },
    documentSize: { width: 400, height: 300 },
    assets: [],
    diagnostics: [],
    nodes: [{ id: "root", children: ["text"], kind: "container", name: "body", source: "body", rect: { x: 0, y: 0, width: 400, height: 300 }, zIndex: 1, paint: { backgroundColor: "rgb(255, 255, 255)" }, layout: { kind: "flex", direction: "column" } }, { id: "text", parentId: "root", children: [], kind: "text", name: "Hello", source: "body ::text", rect: { x: 20, y: 20, width: 80, height: 24 }, zIndex: 2, paint: { color: "rgb(0, 0, 0)" }, layout: { kind: "none" }, text: "Hello", textStyle: { fontFamily: "Inter", fontSize: 16, fontWeight: 400, fontStyle: "normal", lineHeight: 1.5, letterSpacing: 0, textAlign: "left", textDecoration: "none", textTransform: "none" } }]
  };
}

describe("Penpot importer", () => {
  let boards: FakeShape[];
  let undoFinish: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    boards = [];
    undoFinish = vi.fn();
    vi.stubGlobal("penpot", {
      viewport: { center: { x: 100, y: 200 } },
      history: { undoBlockBegin: vi.fn(() => Symbol("undo")), undoBlockFinish: undoFinish },
      createBoard: vi.fn(() => {
        const board = fakeShape("board");
        Object.assign(board, { clipContent: false, showInViewMode: true, fills: [], flex: undefined, addFlexLayout: vi.fn(function (this: FakeShape) { const flex = { appendChild: vi.fn((child: FakeShape) => board.children?.push(child)), dir: "row", wrap: "nowrap", rowGap: 0, columnGap: 0, topPadding: 0, rightPadding: 0, bottomPadding: 0, leftPadding: 0 }; board.flex = flex; return flex; }) });
        boards.push(board);
        return board;
      }),
      createRectangle: vi.fn(() => Object.assign(fakeShape("rectangle"), { fills: [] })),
      createText: vi.fn((characters: string) => {
        const shape = Object.assign(fakeShape("text"), { characters, fills: [], growType: "fixed" });
        let fontFamily = "";
        Object.defineProperty(shape, "fontFamily", {
          configurable: true,
          get: () => fontFamily,
          set: (value: string) => {
            if (value === "Poppins-Regular") throw new Error("font family is not installed");
            fontFamily = value;
          }
        });
        return shape;
      }),
      group: vi.fn((shapes: FakeShape[]) => Object.assign(fakeShape("group"), { children: shapes })),
      createShapeFromSvg: vi.fn(() => null),
      createShapeFromSvgWithImages: vi.fn(),
      uploadMediaData: vi.fn().mockResolvedValue({}),
      uploadMediaUrl: vi.fn().mockResolvedValue({})
    });
  });

  it("creates a top-level board and native children in one undo block", async () => {
    const progress = vi.fn();
    const result = await importScenes([scene()], { isCancelled: () => false, onProgress: progress });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Page — Desktop 400");
    expect((result[0] as unknown as FakeShape).children).toHaveLength(1);
    const text = (result[0] as unknown as FakeShape).children?.[0];
    expect(text).toMatchObject({ type: "text", characters: "Hello", fontSize: "16", lineHeight: "1.5", letterSpacing: "0", x: 120, y: 220 });
    expect(text).not.toHaveProperty("textTransform", null);
    expect((result[0] as unknown as FakeShape).addFlexLayout).not.toHaveBeenCalled();
    expect(undoFinish).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenLastCalledWith(2, 2, "Creating Desktop");
  });

  it("maps browser generic font families to a Penpot-safe fallback", async () => {
    const genericFontScene = scene();
    const textNode = genericFontScene.nodes.find((node) => node.kind === "text");
    if (!textNode || !textNode.textStyle) throw new Error("test scene is missing its text node");
    textNode.textStyle.fontFamily = "system-ui, sans-serif";

    const result = await importScenes([genericFontScene], { isCancelled: () => false, onProgress: vi.fn() });
    expect((result[0] as unknown as FakeShape).children?.[0]).toMatchObject({ fontFamily: "Inter" });
  });

  it("normalizes webfont face names and falls back when Penpot rejects them", async () => {
    const webFontScene = scene();
    const textNode = webFontScene.nodes.find((node) => node.kind === "text");
    if (!textNode || !textNode.textStyle) throw new Error("test scene is missing its text node");
    textNode.textStyle.fontFamily = "Poppins-Regular";

    const result = await importScenes([webFontScene], { isCancelled: () => false, onProgress: vi.fn() });
    expect((result[0] as unknown as FakeShape).children?.[0]).toMatchObject({ fontFamily: "Poppins" });
  });

  it("parses CSS shadow dimensions as finite Penpot values", async () => {
    const shadowScene = scene();
    shadowScene.nodes[0].paint.boxShadow = "0px 4px 20px 0px rgba(0, 0, 0, 0.2)";

    const result = await importScenes([shadowScene], { isCancelled: () => false, onProgress: vi.fn() });
    const shadows = (result[0] as unknown as FakeShape).shadows as Array<Record<string, number>>;
    expect(shadows[0]).toMatchObject({ offsetX: 0, offsetY: 4, blur: 20, spread: 0 });
    expect(Object.values(shadows[0] || {}).every((value) => typeof value !== "number" || Number.isFinite(value))).toBe(true);
  });

  it("creates editable shapes from inlined SVG image assets", async () => {
    const svgScene = scene();
    svgScene.nodes[0].children = ["logo"];
    svgScene.nodes = [svgScene.nodes[0], { id: "logo", parentId: "root", children: [], kind: "image", name: "logo", source: "img", rect: { x: 20, y: 20, width: 80, height: 50 }, zIndex: 2, paint: {}, layout: { kind: "none" }, assetId: "logo-asset" }];
    svgScene.assets = [{ id: "logo-asset", dataUrl: "data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%2010%2010%22%3E%3C%2Fsvg%3E", mimeType: "image/svg+xml" }];
    const svgGroup = fakeShape("group");
    const createSvg = (globalThis as typeof globalThis & { penpot: { createShapeFromSvgWithImages: ReturnType<typeof vi.fn> } }).penpot.createShapeFromSvgWithImages;
    createSvg.mockResolvedValueOnce(svgGroup);

    const result = await importScenes([svgScene], { isCancelled: () => false, onProgress: vi.fn() });
    expect(createSvg).toHaveBeenCalledWith("<svg viewBox=\"0 0 10 10\"></svg>");
    expect((result[0] as unknown as FakeShape).children?.[0]).toBe(svgGroup);
  });

  it("keeps SVGs visible when vector conversion fails", async () => {
    const svgScene = scene();
    svgScene.nodes[0].children = ["logo"];
    svgScene.nodes = [svgScene.nodes[0], { id: "logo", parentId: "root", children: [], kind: "svg", name: "logo", source: "svg", rect: { x: 20, y: 20, width: 80, height: 50 }, zIndex: 2, paint: {}, layout: { kind: "none" }, assetId: "logo-asset" }];
    svgScene.assets = [{ id: "logo-asset", dataUrl: "data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%2010%2010%22%3E%3CforeignObject%20width%3D%2210%22%20height%3D%2210%22%3E%3C%2FforeignObject%3E%3C%2Fsvg%3E", mimeType: "image/svg+xml" }];
    const createSvg = (globalThis as typeof globalThis & { penpot: { createShapeFromSvgWithImages: ReturnType<typeof vi.fn>; createShapeFromSvg: ReturnType<typeof vi.fn> } }).penpot;
    createSvg.createShapeFromSvgWithImages.mockRejectedValueOnce(new Error("unsupported SVG"));
    createSvg.createShapeFromSvg.mockImplementationOnce(() => { throw new Error("unsupported SVG"); });
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/svg+xml" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await importScenes([svgScene], { isCancelled: () => false, onProgress: vi.fn() });
    const imported = (result[0] as unknown as FakeShape).children?.[0];
    expect(imported).toMatchObject({ type: "rectangle", fills: [{ fillImage: {}, fillOpacity: 1 }] });
    expect((imported?.setPluginData as ReturnType<typeof vi.fn>).mock.calls).toContainEqual(["asset-fallback", expect.stringContaining("SVG")]);
    expect(imported?.name).toBe("SVG fallback: logo");
    vi.unstubAllGlobals();
  });

  it("shows one placeholder and caches failed image uploads across boards", async () => {
    const image = (name: string): SceneDocument => {
      const result = scene(name);
      result.nodes[0].children = ["image"];
      result.nodes = [result.nodes[0], { id: "image", parentId: "root", children: [], kind: "image", name: "logo", source: "img", rect: { x: 20, y: 20, width: 80, height: 50 }, zIndex: 2, paint: {}, layout: { kind: "none" }, assetId: "logo-asset" }];
      result.assets = [{ id: "logo-asset", url: "https://example.com/logo.png", mimeType: "image/png" }];
      return result;
    };
    const upload = (globalThis as typeof globalThis & { penpot: { uploadMediaUrl: ReturnType<typeof vi.fn> } }).penpot.uploadMediaUrl;
    upload.mockRejectedValueOnce(new Error("media unavailable"));

    const result = await importScenes([image("Desktop"), image("Mobile")], { isCancelled: () => false, onProgress: vi.fn() });
    expect(upload).toHaveBeenCalledOnce();
    expect((result[0] as unknown as FakeShape).children?.[0]).toMatchObject({ fills: [{ fillColor: "#e5e7eb", fillOpacity: 1 }] });
    expect((result[1] as unknown as FakeShape).children?.[0]).toMatchObject({ fills: [{ fillColor: "#e5e7eb", fillOpacity: 1 }] });
    expect((result[0] as unknown as FakeShape).children?.[0]?.name).toBe("Image unavailable: logo");
  });

  it("uploads inlined raster assets and reuses them across responsive boards", async () => {
    const image = (name: string): SceneDocument => {
      const result = scene(name);
      result.nodes[0].children = ["image"];
      result.nodes = [result.nodes[0], { id: "image", parentId: "root", children: [], kind: "image", name: "logo", source: "img", rect: { x: 20, y: 20, width: 80, height: 50 }, zIndex: 2, paint: {}, layout: { kind: "none" }, assetId: "logo-asset" }];
      result.assets = [{ id: "logo-asset", url: "data:image/png;base64,AQID", mimeType: "image/png" }];
      return result;
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);

    await importScenes([image("Desktop"), image("Mobile")], { isCancelled: () => false, onProgress: vi.fn() });

    const penpotApi = (globalThis as typeof globalThis & { penpot: { uploadMediaData: ReturnType<typeof vi.fn>; uploadMediaUrl: ReturnType<typeof vi.fn> } }).penpot;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(penpotApi.uploadMediaData).toHaveBeenCalledOnce();
    expect(penpotApi.uploadMediaData).toHaveBeenCalledWith("logo-asset", expect.any(Uint8Array), "image/png");
    expect(penpotApi.uploadMediaUrl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("keeps color beneath a container background image", async () => {
    const backgroundScene = scene();
    const root = backgroundScene.nodes[0];
    const text = backgroundScene.nodes[1];
    const hero = {
      ...root,
      id: "hero",
      parentId: root.id,
      children: [text.id],
      name: "hero",
      source: "body > section",
      paint: { backgroundColor: "rgba(20, 30, 40, 0.5)", backgroundImage: "url(https://example.com/hero.png)" },
      assetId: "hero-image"
    };
    text.parentId = hero.id;
    root.children = [hero.id];
    backgroundScene.nodes = [root, hero, text];
    backgroundScene.assets = [{ id: "hero-image", url: "https://example.com/hero.png" }];

    await importScenes([backgroundScene], { isCancelled: () => false, onProgress: vi.fn() });

    const group = (globalThis as typeof globalThis & { penpot: { group: ReturnType<typeof vi.fn> } }).penpot.group.mock.results[0]?.value as FakeShape;
    const backdrop = group.children?.[0];
    expect(backdrop?.fills).toEqual([
      { fillColor: "#141e28", fillOpacity: 0.5 },
      { fillImage: {}, fillOpacity: 1 }
    ]);
    expect((globalThis as typeof globalThis & { penpot: { uploadMediaUrl: ReturnType<typeof vi.fn> } }).penpot.uploadMediaUrl).toHaveBeenCalledOnce();
  });

  it("applies root background images without re-uploading shared media", async () => {
    const desktop = scene();
    const mobile = scene("Mobile");
    for (const document of [desktop, mobile]) {
      document.nodes[0].paint.backgroundImage = "url(https://example.com/page.png)";
      document.nodes[0].assetId = "page-image";
      document.assets = [{ id: "page-image", url: "https://example.com/page.png" }];
    }

    const result = await importScenes([desktop, mobile], { isCancelled: () => false, onProgress: vi.fn() });

    expect((result[0] as unknown as FakeShape).fills).toEqual([{ fillColor: "#ffffff", fillOpacity: 1 }, { fillImage: {}, fillOpacity: 1 }]);
    expect((globalThis as typeof globalThis & { penpot: { uploadMediaUrl: ReturnType<typeof vi.fn> } }).penpot.uploadMediaUrl).toHaveBeenCalledOnce();
  });

  it("preserves color alpha and applies element opacity once", async () => {
    const alphaScene = scene();
    alphaScene.nodes[0].paint = { backgroundColor: "rgba(255, 0, 128, 0.4)", opacity: 0.5 };
    const text = alphaScene.nodes[1];
    text.paint = { color: "#1234", opacity: 0.5 };

    const result = await importScenes([alphaScene], { isCancelled: () => false, onProgress: vi.fn() });

    const board = result[0] as unknown as FakeShape;
    const importedText = board.children?.[0];
    expect(board).toMatchObject({ opacity: 0.5, fills: [{ fillColor: "#ff0080", fillOpacity: 0.4 }] });
    expect(importedText).toMatchObject({ opacity: 0.5, fills: [{ fillColor: "#112233", fillOpacity: 4 / 15 }] });
  });

  it("preserves explicit percentage gradient stops and stop alpha", async () => {
    const gradientScene = scene();
    gradientScene.nodes[0].paint = {
      backgroundImage: "linear-gradient(90deg, rgba(255, 0, 0, 0.25) 15%, #00ff00 70%, rgb(0, 0, 255))"
    };

    const result = await importScenes([gradientScene], { isCancelled: () => false, onProgress: vi.fn() });
    const board = result[0] as unknown as FakeShape;
    expect(board.fills).toEqual([{
      fillColorGradient: expect.objectContaining({
        type: "linear",
        stops: [
          { color: "#ff0000", opacity: 0.25, offset: 0.15 },
          { color: "#00ff00", opacity: 1, offset: 0.7 },
          { color: "#0000ff", opacity: 1, offset: 1 }
        ]
      })
    }]);
  });

  it("retains overflow containers as ordinary groups until masking is verified in Penpot", async () => {
    const clippedScene = scene();
    const root = clippedScene.nodes[0];
    const text = clippedScene.nodes[1];
    const clipped = { ...root, id: "clipped", parentId: root.id, children: [text.id], name: "card", source: "body > section", paint: { overflow: "hidden" as const } };
    text.parentId = clipped.id;
    root.children = [clipped.id];
    clippedScene.nodes = [root, clipped, text];

    await importScenes([clippedScene], { isCancelled: () => false, onProgress: vi.fn() });

    const group = (globalThis as typeof globalThis & { penpot: { group: ReturnType<typeof vi.fn> } }).penpot.group.mock.results[0]?.value as FakeShape;
    expect(group.children).toHaveLength(2);
    expect(group).not.toHaveProperty("makeMask");
  });

  it("commits each responsive board in its own undo block", async () => {
    await importScenes([scene("Desktop"), scene("Mobile")], { isCancelled: () => false, onProgress: vi.fn() });
    expect(undoFinish).toHaveBeenCalledTimes(2);
  });

  it("keeps marked inline text on one line", async () => {
    const noWrapScene = scene();
    const textNode = noWrapScene.nodes.find((node) => node.kind === "text");
    if (!textNode) throw new Error("test scene is missing its text node");
    textNode.textNoWrap = true;

    const result = await importScenes([noWrapScene], { isCancelled: () => false, onProgress: vi.fn() });
    expect((result[0] as unknown as FakeShape).children?.[0]).toMatchObject({ growType: "auto-width" });
  });

  it("scales overflowing text while preserving its line box", async () => {
    const fittedScene = scene();
    const textNode = fittedScene.nodes.find((node) => node.kind === "text");
    if (!textNode || !textNode.textStyle) throw new Error("test scene is missing its text node");
    textNode.textFitScale = 0.8;
    textNode.textStyle.letterSpacing = 2;

    const result = await importScenes([fittedScene], { isCancelled: () => false, onProgress: vi.fn() });
    expect((result[0] as unknown as FakeShape).children?.[0]).toMatchObject({
      fontSize: "12.8",
      lineHeight: "1.875",
      letterSpacing: "1.6"
    });
  });

  it("shrinks an auto-width Penpot line when its fallback font exceeds the captured parent width", async () => {
    const fittedScene = scene();
    const textNode = fittedScene.nodes.find((node) => node.kind === "text");
    if (!textNode || !textNode.textStyle) throw new Error("test scene is missing its text node");
    textNode.textNoWrap = true;
    textNode.textMaxWidth = 200;
    // The enclosing content edge is x=100 despite the inline width of 200.
    fittedScene.nodes[0].rect.width = 120;
    fittedScene.nodes[0].layout.padding = [0, 20, 0, 0];
    const createText = (globalThis as typeof globalThis & { penpot: { createText: ReturnType<typeof vi.fn> } }).penpot.createText;
    createText.mockImplementationOnce((characters: string) => {
      const shape = Object.assign(fakeShape("text"), { characters, fills: [], width: 80 });
      let growType = "fixed";
      let fontSize = "16";
      Object.defineProperty(shape, "fontSize", {
        get: () => fontSize,
        set: (value: string) => {
          fontSize = value;
          if (growType === "auto-width") shape.width = Number(value) * 10;
        }
      });
      Object.defineProperty(shape, "growType", {
        configurable: true,
        get: () => growType,
        set: (value: string) => {
          growType = value;
          if (value === "auto-width") setTimeout(() => { shape.width = Number(fontSize) * 10; }, 50);
        }
      });
      return shape;
    });

    const result = await importScenes([fittedScene], { isCancelled: () => false, onProgress: vi.fn() });
    const imported = (result[0] as unknown as FakeShape).children?.[0];
    expect(Number(imported?.fontSize)).toBeCloseTo(7.95);
    expect(Number(imported?.width)).toBeLessThanOrEqual(80);
    expect(Number(imported?.lineHeight) * Number(imported?.fontSize)).toBeCloseTo(24);
  });

  it("groups painted containers instead of creating nested boards", async () => {
    const nestedScene = scene();
    const root = nestedScene.nodes[0];
    const text = nestedScene.nodes[1];
    const container = { ...root, id: "container", parentId: root.id, children: [text.id], kind: "container" as const, name: "section", source: "body > section", paint: { backgroundColor: "rgb(255, 255, 255)", opacity: 0.8 } };
    text.parentId = container.id;
    root.children = [container.id];
    nestedScene.nodes = [root, container, text];

    await importScenes([nestedScene], { isCancelled: () => false, onProgress: vi.fn() });
    const group = (globalThis as typeof globalThis & { penpot: { group: ReturnType<typeof vi.fn> } }).penpot.group;
    expect(group).toHaveBeenCalledOnce();
    expect(group.mock.results[0]?.value).toMatchObject({ opacity: 0.8 });
  });

  it("removes partial boards when cancellation happens", async () => {
    let checks = 0;
    await expect(importScenes([scene(), scene("Mobile")], { isCancelled: () => ++checks >= 3, onProgress: vi.fn() })).rejects.toBeInstanceOf(ImportCancelledError);
    expect(boards[0].removed).toBe(true);
    expect(undoFinish).toHaveBeenCalledOnce();
  });
});
