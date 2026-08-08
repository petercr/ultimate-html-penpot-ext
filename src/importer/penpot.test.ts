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
    resize: vi.fn(),
    setPluginData: vi.fn(),
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
      createText: vi.fn((characters: string) => Object.assign(fakeShape("text"), { characters, fills: [], growType: "fixed" })),
      group: vi.fn((shapes: FakeShape[]) => Object.assign(fakeShape("group"), { children: shapes })),
      createShapeFromSvgWithImages: vi.fn(),
      uploadMediaData: vi.fn(),
      uploadMediaUrl: vi.fn()
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

  it("keeps marked inline text on one line", async () => {
    const noWrapScene = scene();
    const textNode = noWrapScene.nodes.find((node) => node.kind === "text");
    if (!textNode) throw new Error("test scene is missing its text node");
    textNode.textNoWrap = true;

    const result = await importScenes([noWrapScene], { isCancelled: () => false, onProgress: vi.fn() });
    expect((result[0] as unknown as FakeShape).children?.[0]).toMatchObject({ growType: "auto-width" });
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
