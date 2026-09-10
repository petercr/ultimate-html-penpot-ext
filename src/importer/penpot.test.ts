import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
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
    resize: vi.fn(function (this: FakeShape, width: number, height: number) { this.width = width; this.height = height; }),
    setPluginData: vi.fn(function (this: FakeShape, key: string, value: string) { (this.pluginData as Record<string, string>)[key] = value; }),
    getPluginData: vi.fn(function (this: FakeShape, key: string) { return String((this.pluginData as Record<string, string>)[key] || ""); }),
    appendChild: vi.fn(function (this: FakeShape, child: FakeShape) { this.children?.push(child); }),
    remove: vi.fn(function (this: FakeShape) { this.removed = true; })
  };
}

type BaselineMetadata = {
  inputs: { extractor: { path: string; sha256: string }; assets: Array<{ path: string; sha256: string }> };
  fixtures: Array<{ file: string; sha256: string }>;
};
type BaselineSceneEvidence = {
  fixtures: Array<{ file: string; sha256: string; viewports: Array<{ scene: SceneDocument }> }>;
};

function fixturePath(path: string): string {
  return resolve(process.cwd(), "src", "capture", "fixtures", path);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function baselineEvidence(): { metadata: BaselineMetadata; scenes: BaselineSceneEvidence } {
  return {
    metadata: JSON.parse(readFileSync(fixturePath("baselines/metadata.json"), "utf8")) as BaselineMetadata,
    scenes: JSON.parse(readFileSync(fixturePath("baselines/scene-evidence.json"), "utf8")) as BaselineSceneEvidence
  };
}

function scenesForFixture(evidence: BaselineSceneEvidence, file: string): SceneDocument[] {
  const fixture = evidence.fixtures.find((candidate) => candidate.file === file);
  if (!fixture) throw new Error(`Missing generated scene evidence for ${file}.`);
  return fixture.viewports.map(({ scene }) => scene);
}

function shapesBelow(shape: FakeShape, seen = new Set<FakeShape>()): FakeShape[] {
  if (seen.has(shape)) return [];
  seen.add(shape);
  return [shape, ...(shape.children || []).flatMap((child) => shapesBelow(child, seen))];
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

  it("keeps checked-in fixture evidence synchronized with its source, assets, and extractor", () => {
    const { metadata, scenes } = baselineEvidence();
    expect(metadata.inputs.extractor.path).toBe("src/capture/extractor.ts");
    expect(metadata.inputs.extractor.sha256).toBe(sha256File(resolve(process.cwd(), "src", "capture", "extractor.ts")));

    const expectedAssetPaths = readdirSync(fixturePath("assets"))
      .filter((file) => [".svg", ".ttf", ".otf", ".woff", ".woff2"].some((extension) => file.endsWith(extension)))
      .sort()
      .map((file) => `src/capture/fixtures/assets/${file}`);
    expect(metadata.inputs.assets.map((asset) => asset.path)).toEqual(expectedAssetPaths);
    for (const asset of metadata.inputs.assets) {
      expect(asset.sha256).toBe(sha256File(fixturePath(asset.path.replace("src/capture/fixtures/", ""))));
    }

    expect(scenes.fixtures.map((fixture) => fixture.file)).toEqual(metadata.fixtures.map((fixture) => fixture.file));
    for (const fixture of metadata.fixtures) {
      const generated = scenes.fixtures.find((candidate) => candidate.file === fixture.file);
      expect(generated?.sha256).toBe(fixture.sha256);
      expect(fixture.sha256).toBe(sha256File(fixturePath(fixture.file)));
    }
  });

  it("imports generated clipping scenes with bounded clip boards and nested ancestry", async () => {
    const scenes = scenesForFixture(baselineEvidence().scenes, "overflow-clipping.html");
    const result = await importScenes(scenes, { isCancelled: () => false, onProgress: vi.fn() });
    expect(result).toHaveLength(3);

    for (const [index, scene] of scenes.entries()) {
      const board = result[index] as unknown as FakeShape;
      const outerNode = scene.nodes.find((node) => node.source === "#outer-clip");
      const innerNode = scene.nodes.find((node) => node.source === "#inner-clip");
      if (!outerNode || !innerNode) throw new Error("Generated clipping scene is incomplete.");
      const viewportId = scene.viewport.id;
      const clipFor = (source: string) => boards.find((shape) => shape !== board && (shape.pluginData as Record<string, string>).source === source && (shape.pluginData as Record<string, string>).viewport === viewportId);
      const outerClip = clipFor("#outer-clip");
      const innerClip = clipFor("#inner-clip");
      const boardX = Number(board.x);
      const boardY = Number(board.y);
      expect(board).toMatchObject({ clipContent: true, width: scene.viewport.width, height: scene.documentSize.height });
      expect(outerClip).toMatchObject({ type: "board", clipContent: true, x: boardX + outerNode.rect.x, y: boardY + outerNode.rect.y, width: outerNode.rect.width, height: outerNode.rect.height });
      expect(innerClip).toMatchObject({ type: "board", clipContent: true, x: boardX + innerNode.rect.x, y: boardY + innerNode.rect.y, width: innerNode.rect.width, height: innerNode.rect.height });
      expect(board.children).toContain(outerClip);
      expect(outerClip?.children).toContain(innerClip);
    }
  });

  it("imports generated opacity scenes with each compositing opacity applied once", async () => {
    const scenes = scenesForFixture(baselineEvidence().scenes, "color-opacity.html");
    await importScenes(scenes, { isCancelled: () => false, onProgress: vi.fn() });
    const groups = (globalThis as typeof globalThis & { penpot: { group: ReturnType<typeof vi.fn> } }).penpot.group.mock.results.map((result) => result.value as FakeShape);

    for (const scene of scenes) {
      const viewportId = scene.viewport.id;
      const nestedOpacity = groups.find((shape) => (shape.pluginData as Record<string, string>).source === "#nested-opacity" && (shape.pluginData as Record<string, string>).viewport === viewportId);
      const decoratedText = groups.find((shape) => (shape.pluginData as Record<string, string>).source === "#decorated-text" && (shape.pluginData as Record<string, string>).viewport === viewportId);
      expect(nestedOpacity?.opacity).toBe(0.25);
      expect(decoratedText?.opacity).toBe(0.5);
    }
  });

  it("imports generated failed-asset scenes with a placeholder per element and one upload across three boards", async () => {
    const scenes = scenesForFixture(baselineEvidence().scenes, "asset-failures.html");
    const upload = (globalThis as typeof globalThis & { penpot: { uploadMediaUrl: ReturnType<typeof vi.fn> } }).penpot.uploadMediaUrl;
    upload.mockRejectedValueOnce(new Error("controlled fixture asset failure"));

    const result = await importScenes(scenes, { isCancelled: () => false, onProgress: vi.fn() });
    expect(result).toHaveLength(3);
    expect(upload).toHaveBeenCalledOnce();
    for (const board of result as unknown as FakeShape[]) {
      const placeholders = shapesBelow(board).filter((shape) => Boolean((shape.pluginData as Record<string, string>)["asset-fallback"]));
      expect(placeholders).toHaveLength(3);
      expect(placeholders.map((shape) => (shape.pluginData as Record<string, string>).source).sort()).toEqual(["#missing-background", "#missing-image-a", "#missing-image-b"]);
      expect(placeholders.map((shape) => shape.name).sort()).toEqual(["Image unavailable: missing-background", "Image unavailable: missing-image-a", "Image unavailable: missing-image-b"]);
    }
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

  it("preserves translucent shadow color while parsing finite dimensions", async () => {
    const shadowScene = scene();
    shadowScene.nodes[0].paint.boxShadow = "0px 4px 20px 0px rgba(0, 0, 0, 0.2)";

    const result = await importScenes([shadowScene], { isCancelled: () => false, onProgress: vi.fn() });
    const shadows = (result[0] as unknown as FakeShape).shadows as Array<Record<string, unknown>>;
    expect(shadows[0]).toMatchObject({ offsetX: 0, offsetY: 4, blur: 20, spread: 0, color: { color: "#000000", opacity: 0.2 } });
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

  it("keeps a named placeholder for every element that shares one failed asset", async () => {
    const failing = scene();
    const root = failing.nodes[0];
    root.children = ["first", "second"];
    failing.nodes = [
      root,
      { id: "first", parentId: root.id, children: [], kind: "image", name: "first broken image", source: "#missing-image-a", rect: { x: 20, y: 20, width: 80, height: 50 }, zIndex: 2, paint: {}, layout: { kind: "none" }, assetId: "missing-asset" },
      { id: "second", parentId: root.id, children: [], kind: "image", name: "second broken image", source: "#missing-image-b", rect: { x: 120, y: 20, width: 80, height: 50 }, zIndex: 3, paint: {}, layout: { kind: "none" }, assetId: "missing-asset" }
    ];
    failing.assets = [{ id: "missing-asset", url: "http://127.0.0.1:4174/assets/intentional-missing.png", mimeType: "image/png" }];
    const upload = (globalThis as typeof globalThis & { penpot: { uploadMediaUrl: ReturnType<typeof vi.fn> } }).penpot.uploadMediaUrl;
    upload.mockRejectedValueOnce(new Error("controlled local failure"));

    const result = await importScenes([failing], { isCancelled: () => false, onProgress: vi.fn() });
    const names = (result[0] as unknown as FakeShape).children?.map((child) => child.name);
    expect(upload).toHaveBeenCalledOnce();
    expect(names).toEqual(["Image unavailable: first broken image", "Image unavailable: second broken image"]);
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
    alphaScene.nodes[0].paint = {
      backgroundColor: "rgba(255, 0, 128, 0.4)",
      borderColor: "#12345680",
      borderWidth: 2,
      borderStyle: "solid",
      opacity: 0.5
    };
    const text = alphaScene.nodes[1];
    text.paint = { color: "#1234", opacity: 0.5 };

    const result = await importScenes([alphaScene], { isCancelled: () => false, onProgress: vi.fn() });

    const board = result[0] as unknown as FakeShape;
    const importedText = board.children?.[0];
    expect(board).toMatchObject({ opacity: 0.5, fills: [{ fillColor: "#ff0080", fillOpacity: 0.4 }] });
    expect(board.strokes).toEqual([{ strokeColor: "#123456", strokeOpacity: 128 / 255, strokeWidth: 2, strokeStyle: "solid", strokeAlignment: "center" }]);
    expect(importedText).toMatchObject({ opacity: 0.5, fills: [{ fillColor: "#112233", fillOpacity: 4 / 15 }] });
  });

  it("creates an explicitly transparent text fill instead of the host default black", async () => {
    const transparentTextScene = scene();
    const text = transparentTextScene.nodes[1];
    text.paint = { color: "transparent", opacity: 0.5 };

    const result = await importScenes([transparentTextScene], { isCancelled: () => false, onProgress: vi.fn() });
    expect((result[0] as unknown as FakeShape).children?.[0]).toMatchObject({
      opacity: 0.5,
      fills: [{ fillColor: "#000000", fillOpacity: 0 }]
    });
  });

  it("keeps nested and decorated direct-text opacity on their separate compositing groups", async () => {
    const opacityScene = scene();
    const root = opacityScene.nodes[0];
    const text = opacityScene.nodes[1];
    const outer = { ...root, id: "outer", parentId: root.id, children: ["decorated"], kind: "container" as const, name: "outer", source: "body > section", paint: { opacity: 0.5 } };
    const decorated = {
      ...root,
      id: "decorated",
      parentId: outer.id,
      children: [text.id],
      kind: "container" as const,
      name: "decorated text",
      source: "body > section > span",
      paint: { backgroundColor: "rgba(30, 60, 90, 0.4)", borderColor: "rgba(10, 20, 30, 0.5)", borderWidth: 1, borderStyle: "solid", opacity: 0.5 }
    };
    text.parentId = decorated.id;
    text.paint = { color: "rgb(12, 34, 56)", opacity: 1 };
    root.children = [outer.id];
    opacityScene.nodes = [root, outer, decorated, text];

    await importScenes([opacityScene], { isCancelled: () => false, onProgress: vi.fn() });

    const groups = (globalThis as typeof globalThis & { penpot: { group: ReturnType<typeof vi.fn> } }).penpot.group;
    // A decoration supplies the compositing group. The undecorated outer
    // wrapper can reuse it, yielding CSS's .5 × .5 final opacity without
    // applying the decorated element's opacity to its text twice.
    expect(groups).toHaveBeenCalledOnce();
    expect((groups.mock.results[0]?.value as FakeShape).opacity).toBe(0.25);
    const decoratedBackdrop = groups.mock.calls[0]?.[0]?.[0] as FakeShape;
    expect(decoratedBackdrop).toMatchObject({
      fills: [{ fillColor: "#1e3c5a", fillOpacity: 0.4 }],
      strokes: [{ strokeColor: "#0a141e", strokeOpacity: 0.5 }]
    });
    expect(groups.mock.calls[0]?.[0]?.[1]).toMatchObject({ opacity: 1, fills: [{ fillColor: "#0c2238", fillOpacity: 1 }] });
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

  it("omits an unsupported gradient instead of silently dropping its stop", async () => {
    const gradientScene = scene();
    gradientScene.nodes[0].paint = {
      backgroundImage: "linear-gradient(90deg, #2563eb, color(display-p3 0.95 0.2 0.35), #facc15)"
    };

    const result = await importScenes([gradientScene], { isCancelled: () => false, onProgress: vi.fn() });
    expect((result[0] as unknown as FakeShape).fills).toEqual([]);
  });

  it("rejects unsupported first, middle, last, and color-hint gradient components", async () => {
    for (const backgroundImage of [
      "linear-gradient(color(display-p3 0.95 0.2 0.35), rgb(1, 2, 3), rgb(4, 5, 6))",
      "linear-gradient(rgb(1, 2, 3), color(display-p3 0.95 0.2 0.35), rgb(4, 5, 6))",
      "linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6), color(display-p3 0.95 0.2 0.35))",
      "linear-gradient(30%, rgb(1, 2, 3), rgb(4, 5, 6))"
    ]) {
      const gradientScene = scene();
      gradientScene.nodes[0].paint = { backgroundImage };
      const result = await importScenes([gradientScene], { isCancelled: () => false, onProgress: vi.fn() });
      expect((result[0] as unknown as FakeShape).fills).toEqual([]);
    }
  });

  it("accepts only recognized direction and shape preludes for supported gradients", async () => {
    const gradientScene = scene();
    gradientScene.nodes[0].paint = {
      backgroundImage: "linear-gradient(90deg, rgb(100% 0% 0% / 50%), rgb(0, 100%, 0))"
    };
    const radialScene = scene("Radial");
    radialScene.nodes[0].paint = {
      backgroundImage: "radial-gradient(at 25% 75%, rgb(0 0 100% / 25%), transparent)"
    };
    const lengthRadialScene = scene("Length radial");
    lengthRadialScene.nodes[0].paint = {
      backgroundImage: "radial-gradient(20px at center, rgb(0, 0, 0), rgb(255, 255, 255))"
    };

    const result = await importScenes([gradientScene, radialScene, lengthRadialScene], { isCancelled: () => false, onProgress: vi.fn() });
    expect((result[0] as unknown as FakeShape).fills).toEqual([{
      fillColorGradient: expect.objectContaining({
        type: "linear",
        stops: [
          { color: "#ff0000", opacity: 0.5, offset: 0 },
          { color: "#00ff00", opacity: 1, offset: 1 }
        ]
      })
    }]);
    expect((result[1] as unknown as FakeShape).fills).toEqual([{
      fillColorGradient: expect.objectContaining({
        type: "radial",
        stops: [
          { color: "#0000ff", opacity: 0.25, offset: 0 },
          { color: "#000000", opacity: 0, offset: 1 }
        ]
      })
    }]);
    expect((result[2] as unknown as FakeShape).fills).toEqual([{
      fillColorGradient: expect.objectContaining({ type: "radial" })
    }]);
  });

  it("clamps explicit backwards percentage stops before interpolating omitted stops", async () => {
    const gradientScene = scene();
    gradientScene.nodes[0].paint = {
      backgroundImage: "linear-gradient(rgb(1,2,3) 80%, rgb(4,5,6) 20%, rgb(7,8,9) 30%)"
    };
    const omittedScene = scene("Omitted");
    omittedScene.nodes[0].paint = {
      backgroundImage: "linear-gradient(rgb(1,2,3) 80%, rgb(4,5,6), rgb(7,8,9) 20%)"
    };

    const result = await importScenes([gradientScene, omittedScene], { isCancelled: () => false, onProgress: vi.fn() });
    const stops = ((result[0] as unknown as { fills: Array<{ fillColorGradient: { stops: Array<{ offset: number }> } }> }).fills[0]).fillColorGradient.stops;
    const omitted = ((result[1] as unknown as { fills: Array<{ fillColorGradient: { stops: Array<{ offset: number }> } }> }).fills[0]).fillColorGradient.stops;
    expect(stops.map((stop) => stop.offset)).toEqual([0.8, 0.8, 0.8]);
    expect(omitted.map((stop) => stop.offset)).toEqual([0.8, 0.8, 0.8]);
  });

  it("rejects non-finite color alpha and leaves fully transparent containers without backdrops", async () => {
    const invalid = scene();
    invalid.nodes[0].paint = { backgroundImage: "linear-gradient(rgba(0, 0, 0, .), rgb(1, 2, 3), rgb(4, 5, 6))" };
    const transparentContainer = {
      ...invalid.nodes[0],
      id: "transparent-container",
      parentId: "root",
      children: ["text"],
      kind: "container" as const,
      paint: { backgroundColor: " RGBA(0, 0, 0, 0) " }
    };
    invalid.nodes[0].children = [transparentContainer.id];
    invalid.nodes[1].parentId = transparentContainer.id;
    invalid.nodes.push(transparentContainer);

    const result = await importScenes([invalid], { isCancelled: () => false, onProgress: vi.fn() });
    expect((result[0] as unknown as FakeShape).fills).toEqual([]);
    expect((globalThis as typeof globalThis & { penpot: { group: ReturnType<typeof vi.fn> } }).penpot.group).not.toHaveBeenCalled();
  });

  it("clips an overflowing child inside a board that keeps the captured container bounds", async () => {
    const clippedScene = scene();
    const root = clippedScene.nodes[0];
    const text = clippedScene.nodes[1];
    const clipped = {
      ...root,
      id: "clipped",
      parentId: root.id,
      children: [text.id],
      name: "card",
      source: "body > section",
      rect: { x: 10, y: 10, width: 120, height: 60 },
      paint: { backgroundColor: "rgb(255, 255, 255)", radius: [8, 8, 8, 8] as [number, number, number, number], overflow: "hidden" as const }
    };
    // A child far wider than its container: a group would grow to enclose it.
    text.parentId = clipped.id;
    text.rect = { x: 10, y: 10, width: 400, height: 24 };
    root.children = [clipped.id];
    clippedScene.nodes = [root, clipped, text];

    await importScenes([clippedScene], { isCancelled: () => false, onProgress: vi.fn() });

    const penpotApi = (globalThis as typeof globalThis & { penpot: { group: ReturnType<typeof vi.fn>; createBoard: ReturnType<typeof vi.fn> } }).penpot;
    expect(penpotApi.group).not.toHaveBeenCalled();
    const clip = boards[1];
    expect(clip).toMatchObject({ type: "board", clipContent: true, name: "card", x: 110, y: 210 });
    expect(clip.resize).toHaveBeenCalledWith(120, 60);
    expect(clip).toMatchObject({ fills: [{ fillColor: "#ffffff", fillOpacity: 1 }], borderRadiusTopLeft: 8 });
    expect(clip.children?.map((child) => child.type)).toEqual(["text"]);
    // The container's bounds come from its own captured rect, not from the
    // overflowing child, and the child keeps its captured page position.
    expect(clip.children?.[0]).toMatchObject({ x: 110, y: 210 });
    expect(clip.pluginData).toMatchObject({ source: "body > section" });
  });

  it("nests clipping boards and keeps ordinary groups for visible overflow", async () => {
    const nestedScene = scene();
    const root = nestedScene.nodes[0];
    const text = nestedScene.nodes[1];
    const outerClip = { ...root, id: "outer", parentId: root.id, children: ["visible"], name: "outer", source: "body > section", rect: { x: 0, y: 0, width: 200, height: 100 }, paint: { overflow: "hidden" as const } };
    const visible = { ...root, id: "visible", parentId: "outer", children: ["inner"], name: "visible wrapper", source: "body > section > div", rect: { x: 0, y: 0, width: 200, height: 100 }, paint: { backgroundColor: "rgb(1, 2, 3)" } };
    const innerClip = { ...root, id: "inner", parentId: "visible", children: [text.id], name: "inner", source: "body > section > div > span", rect: { x: 5, y: 5, width: 50, height: 20 }, paint: { overflow: "clip" as const } };
    text.parentId = innerClip.id;
    root.children = [outerClip.id];
    nestedScene.nodes = [root, outerClip, visible, innerClip, text];

    await importScenes([nestedScene], { isCancelled: () => false, onProgress: vi.fn() });

    const outer = boards[1];
    const inner = boards[2];
    expect(outer).toMatchObject({ type: "board", clipContent: true, name: "outer" });
    expect(inner).toMatchObject({ type: "board", clipContent: true, name: "inner" });
    // The painted wrapper between the two clips stays an ordinary group, and
    // the inner clip is placed inside the outer one rather than beside it.
    const group = (globalThis as typeof globalThis & { penpot: { group: ReturnType<typeof vi.fn> } }).penpot.group;
    expect(group).toHaveBeenCalledOnce();
    const wrapper = group.mock.results[0]?.value as FakeShape;
    expect(wrapper).toMatchObject({ type: "group", name: "visible wrapper" });
    expect(wrapper.children?.map((child) => child.type)).toEqual(["rectangle", "board"]);
    expect(wrapper.children?.[1]).toBe(inner);
    expect(outer.children).toContain(inner);
    expect(inner.children?.map((child) => child.type)).toEqual(["text"]);
  });

  it("leaves single-axis clipping unclipped rather than hiding content the browser shows", async () => {
    const partialScene = scene();
    const root = partialScene.nodes[0];
    const text = partialScene.nodes[1];
    // Capture only sets overflow when both axes clip, so overflow-x: clip with
    // overflow-y: visible arrives as visible plus a capture diagnostic.
    const partial = { ...root, id: "partial", parentId: root.id, children: [text.id], name: "partial", source: "body > section", paint: { overflowX: "clip", overflowY: "visible", overflow: "visible" as const } };
    text.parentId = partial.id;
    root.children = [partial.id];
    partialScene.nodes = [root, partial, text];

    await importScenes([partialScene], { isCancelled: () => false, onProgress: vi.fn() });

    expect(boards).toHaveLength(1);
    expect(boards[0].children?.map((child) => child.type)).toEqual(["text"]);
  });

  it("keeps the clipping container's own background image and reports a failed one", async () => {
    const backgroundScene = scene();
    const root = backgroundScene.nodes[0];
    const text = backgroundScene.nodes[1];
    const clipped = { ...root, id: "clipped", parentId: root.id, children: [text.id], name: "hero", source: "body > section", paint: { backgroundImage: 'url("https://example.test/hero.png")', overflow: "hidden" as const }, assetId: "hero" };
    text.parentId = clipped.id;
    root.children = [clipped.id];
    backgroundScene.nodes = [root, clipped, text];
    backgroundScene.assets = [{ id: "hero", url: "https://example.test/hero.png", mimeType: "image/png" }];
    (globalThis as typeof globalThis & { penpot: { uploadMediaUrl: ReturnType<typeof vi.fn> } }).penpot.uploadMediaUrl.mockRejectedValue(new Error("blocked"));

    await importScenes([backgroundScene], { isCancelled: () => false, onProgress: vi.fn() });

    const clip = boards[1];
    expect(clip).toMatchObject({ type: "board", clipContent: true });
    expect(clip.name).toBe("Image unavailable: hero");
    expect(clip.pluginData).toMatchObject({ "asset-fallback": expect.stringContaining("Background image could not be loaded") });
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
