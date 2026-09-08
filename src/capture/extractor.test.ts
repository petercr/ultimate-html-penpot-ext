import { describe, expect, it, vi } from "vitest";
import type { SceneDocument, ViewportSpec } from "../shared/contracts";
import { importScenes } from "../importer/penpot";
import { buildExtractorScript } from "./extractor";

const TEST_VIEWPORT: ViewportSpec = { id: "test", name: "Test", width: 25, height: 15 };

/** Run the async capture script as the sandbox host does: only its matching
 * token may complete this invocation, and listeners/timers always clean up. */
function captureScript(token: string, viewport = TEST_VIEWPORT): Promise<SceneDocument> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("message", receive);
      window.clearTimeout(timeout);
    };
    const receive = (event: MessageEvent) => {
      if (event.data?.token !== token) return;
      if (event.data.type === "CAPTURE_RESULT") {
        cleanup();
        resolve(event.data.scene as SceneDocument);
      } else if (event.data.type === "CAPTURE_ERROR") {
        cleanup();
        reject(new Error(event.data.message || "Capture failed."));
      }
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Capture ${token} did not complete within the test timeout.`));
    }, 5_000);
    window.addEventListener("message", receive);
    try {
      window.eval(buildExtractorScript(token, viewport, 0));
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

describe("extractor script", () => {
  it("embeds the viewport, token, and protocol result", () => {
    const script = buildExtractorScript("nonce-token", { id: "mobile", name: "Mobile", width: 390, height: 844 }, 1200);
    expect(script).toContain("nonce-token");
    expect(script).toContain('"width":390');
    expect(script).toContain("CAPTURE_RESULT");
    expect(script).toContain("UNSUPPORTED_SUBTREE");
    expect(script).toContain("nodeById.get(parentId)?.children.push(id)");
    expect(script).toContain("settleWithin");
    expect(script).not.toContain("requestAnimationFrame");
  });

  it("emits layout-preserving text capture code", () => {
    const script = buildExtractorScript("token", { id: "tablet", name: "Tablet", width: 768, height: 1024 }, 0);
    expect(script).toContain("const textLayout");
    expect(script).toContain("const lineHeightOf");
    expect(script).toContain("measuredLineHeight");
    expect(script).toContain("const textFitScaleOf");
    expect(script).toContain("const textMaxWidthOf");
    expect(script).toContain("textMaxWidth");
    expect(script).toContain("textFitScale");
    expect(script).toContain("textNoWrap");
    expect(script).toContain("inlineControlAncestor");
    expect(script).toContain("one fixed text box per source line");
    expect(script).toContain("textNoWrap: true");
    expect(script).toContain("const paintOfElement");
    expect(script).toContain("const materializeSvgBackground");
    expect(script).toContain("const backgroundLayers");
    expect(script).toContain("MULTIPLE_BACKGROUND_LAYERS");
    expect(script).toContain("backgroundRepeat");
    expect(script).toContain("backgroundPosition");
    expect(script).toContain("backgroundSize");
    expect(script).toContain("const svgMarkupOf");
    expect(script).toContain("http://www.w3.org/2000/svg");
    expect(script).toContain("presentationProperties");
    expect(script).toContain('if (tag === "svg") return id');
    expect(script).toContain("backgroundUrl(paint.backgroundImage)");
    expect(script).toContain("document.documentElement");
    expect(script).toContain("rgb(255, 255, 255)");
    expect(script).toContain("const dataUrl");
    expect(script).toContain('if (tag === "br") return');
    expect(script).toContain("waitForDomSettle");
    expect(script).toContain("const suppressesSubtree");
    expect(script).toContain("display: contents");
    expect(script).toContain("const survivingParent");
    expect(script).toContain("SCRIPTS_DISABLED");
    expect(script).toContain("EMPTY_CAPTURE");
    expect(() => new Function(script)).not.toThrow();
  });

  it("keeps decorated text elements as containers so fills survive", () => {
    const script = buildExtractorScript("token", { id: "desktop", name: "Desktop", width: 1440, height: 900 }, 0);
    expect(script).toContain("const decorated");
    expect(script).toContain("!transparent(style.backgroundColor)");
    expect(script).toContain("childElements.length === 0 && !decorated");
    expect(() => new Function(script)).not.toThrow();
  });

  it("materializes repeating SVG backgrounds at the captured element size", async () => {
    const tile = encodeURIComponent("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><path d=\"M0 0h2v2H0z\"/></svg>");
    document.body.innerHTML = `<div style="opacity:1;visibility:visible"><div id="anchor" style="width:25px;height:15px;opacity:1;visibility:visible;background-repeat:repeat;background-size:auto;background-position:0% 0%"></div></div>`;
    document.body.style.cssText = "opacity:1;visibility:visible";
    const anchor = document.querySelector("#anchor") as HTMLElement;
    anchor.style.backgroundImage = `url("data:image/svg+xml,${tile}")`;
    const bounds = (element: Element) => {
      const width = 25;
      const height = 15;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
    };
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    const originalComputedStyle = window.getComputedStyle;
    const originalCss = window.CSS;
    HTMLElement.prototype.getBoundingClientRect = function () { return bounds(this); };
    window.getComputedStyle = ((element: Element) => originalComputedStyle.call(window, element)) as typeof window.getComputedStyle;
    Object.defineProperty(window, "CSS", { value: { escape: (value: string) => value }, configurable: true });
    try {
      const result = await captureScript("anchor-test");
      const node = result.nodes.find((candidate) => candidate.source === "#anchor");
      const asset = node && result.assets.find((candidate) => candidate.id === node.assetId);
      expect(result).toBeDefined();
      expect(node).toBeDefined();
      expect(asset?.dataUrl).toContain("data:image/svg+xml,");
      const materialized = decodeURIComponent((asset?.dataUrl || "").split(",", 2)[1]);
      expect(materialized).toContain('viewBox="0 0 25 15"');
      expect(materialized.match(/<g /g)?.length).toBe(6);
      expect(materialized).toContain("translate(0 0)");
      expect(materialized).toContain("translate(20 10)");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalBounds;
      window.getComputedStyle = originalComputedStyle;
      Object.defineProperty(window, "CSS", { value: originalCss, configurable: true });
    }
  });

  it("keeps the topmost background layer and reports omitted lower layers", async () => {
    document.body.innerHTML = `<div id="layered" style="width:25px;height:15px;opacity:1;visibility:visible"></div>`;
    document.body.style.cssText = "opacity:1;visibility:visible";
    const layered = document.querySelector("#layered") as HTMLElement;
    layered.style.backgroundImage = 'linear-gradient(rgb(1, 2, 3), rgb(4, 5, 6)), url("https://example.com/lower.png")';
    const bounds = { x: 0, y: 0, left: 0, top: 0, right: 25, bottom: 15, width: 25, height: 15, toJSON: () => ({}) };
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    const originalComputedStyle = window.getComputedStyle;
    const originalCss = window.CSS;
    HTMLElement.prototype.getBoundingClientRect = function () { return bounds; };
    window.getComputedStyle = ((element: Element) => originalComputedStyle.call(window, element)) as typeof window.getComputedStyle;
    Object.defineProperty(window, "CSS", { value: { escape: (value: string) => value }, configurable: true });
    try {
      const result = await captureScript("layered-test");
      const node = result.nodes.find((candidate) => candidate.source === "#layered");
      expect(node?.paint.backgroundImage).toMatch(/^linear-gradient/);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "MULTIPLE_BACKGROUND_LAYERS", source: "#layered" })
      ]));
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalBounds;
      window.getComputedStyle = originalComputedStyle;
      Object.defineProperty(window, "CSS", { value: originalCss, configurable: true });
    }
  });

  it("reports CSS Color 4 paint values that the importer cannot represent", async () => {
    document.body.innerHTML = `<div id="modern" style="width:25px;height:15px;opacity:1;visibility:visible"></div>`;
    document.body.style.cssText = "opacity:1;visibility:visible";
    const modern = document.querySelector("#modern") as HTMLElement;
    const bounds = { x: 0, y: 0, left: 0, top: 0, right: 25, bottom: 15, width: 25, height: 15, toJSON: () => ({}) };
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    const originalComputedStyle = window.getComputedStyle;
    const originalCss = window.CSS;
    HTMLElement.prototype.getBoundingClientRect = function () { return bounds; };
    window.getComputedStyle = ((element: Element) => {
      // jsdom reports pseudo-element computed-style access as unimplemented;
      // the extractor only needs the ordinary style for this diagnostic test.
      const style = originalComputedStyle.call(window, element);
      if (element !== modern) return style;
      const modernStyle = Object.create(style) as CSSStyleDeclaration;
      Object.defineProperty(modernStyle, "backgroundColor", { value: "color(display-p3 0.95 0.2 0.35 / 0.8)" });
      return modernStyle;
    }) as typeof window.getComputedStyle;
    Object.defineProperty(window, "CSS", { value: { escape: (value: string) => value }, configurable: true });
    try {
      const result = await captureScript("modern-color-test");
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "UNSUPPORTED_COLOR_FORMAT", source: "#modern" })
      ]));
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalBounds;
      window.getComputedStyle = originalComputedStyle;
      Object.defineProperty(window, "CSS", { value: originalCss, configurable: true });
    }
  });

  it("reports only rendered pseudo and omitted-wrapper text colors with their actual sources", async () => {
    document.body.innerHTML = `<div id="parent" style="width:25px;height:15px;opacity:1;visibility:visible"><span id="contents" style="display:contents;opacity:1;visibility:visible">Direct text</span></div>`;
    document.body.style.cssText = "opacity:1;visibility:visible";
    const parent = document.querySelector("#parent") as HTMLElement;
    const contents = document.querySelector("#contents") as HTMLElement;
    const bounds = (element: Element) => element === contents
      ? { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }
      : { x: 0, y: 0, left: 0, top: 0, right: 25, bottom: 15, width: 25, height: 15, toJSON: () => ({}) };
    const line = { x: 1, y: 1, left: 1, top: 1, right: 12, bottom: 11, width: 11, height: 10, toJSON: () => ({}) };
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    const originalComputedStyle = window.getComputedStyle;
    const originalCreateRange = document.createRange;
    const originalCss = window.CSS;
    HTMLElement.prototype.getBoundingClientRect = function () { return bounds(this); };
    document.createRange = (() => ({ selectNodeContents: () => undefined, setStart: () => undefined, setEnd: () => undefined, getClientRects: () => [line], getBoundingClientRect: () => line })) as unknown as typeof document.createRange;
    window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      const style = Object.create(originalComputedStyle.call(window, element)) as CSSStyleDeclaration;
      const set = (name: string, value: string) => Object.defineProperty(style, name, { value, configurable: true });
      if (element === parent) {
        set("color", "color(display-p3 1 0 0)");
        set("borderTopColor", "color(display-p3 1 0 0)");
        set("borderTopWidth", "0px");
        set("borderTopStyle", "solid");
        set("backgroundImage", 'url("https://example.invalid/color(display-p3).png")');
        if (pseudo === "::before") {
          set("content", '"before"');
          set("color", "color(display-p3 1 0 0)");
          set("opacity", "1");
        }
      }
      if (element === contents) set("color", "color(display-p3 0 1 0)");
      return style;
    }) as typeof window.getComputedStyle;
    Object.defineProperty(window, "CSS", { value: { escape: (value: string) => value }, configurable: true });
    try {
      const result = await captureScript("rendered-text-colors");
      const colorDiagnostics = result.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_COLOR_FORMAT");
      expect(colorDiagnostics).toHaveLength(2);
      expect(colorDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "#parent ::before", message: expect.stringContaining("uses Penpot's default color") }),
        expect.objectContaining({ source: "#contents ::text", message: expect.stringContaining("uses Penpot's default color") })
      ]));
      expect(colorDiagnostics.some((diagnostic) => diagnostic.message.includes("border color"))).toBe(false);
      expect(colorDiagnostics.some((diagnostic) => diagnostic.message.includes("background gradient"))).toBe(false);
      expect(result.nodes.find((node) => node.text === "Direct text")).toMatchObject({ source: "#contents ::text" });
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalBounds;
      window.getComputedStyle = originalComputedStyle;
      document.createRange = originalCreateRange;
      Object.defineProperty(window, "CSS", { value: originalCss, configurable: true });
    }
  });

  it("captures overflow per axis and diagnoses clipping Penpot cannot reproduce", async () => {
    document.body.innerHTML = `<div id="single" style="width:25px;height:15px;opacity:1;visibility:visible;overflow-x:clip;overflow-y:visible"></div><div id="both" style="width:25px;height:15px;opacity:1;visibility:visible;overflow:auto"></div><div id="plain" style="width:25px;height:15px;opacity:1;visibility:visible"></div>`;
    document.body.style.cssText = "opacity:1;visibility:visible";
    const bounds = { x: 0, y: 0, left: 0, top: 0, right: 25, bottom: 15, width: 25, height: 15, toJSON: () => ({}) };
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    const originalComputedStyle = window.getComputedStyle;
    const originalCss = window.CSS;
    HTMLElement.prototype.getBoundingClientRect = function () { return bounds; };
    window.getComputedStyle = ((element: Element) => originalComputedStyle.call(window, element)) as typeof window.getComputedStyle;
    Object.defineProperty(window, "CSS", { value: { escape: (value: string) => value }, configurable: true });
    try {
      const result = await captureScript("overflow-axes");
      const paintOf = (source: string) => result.nodes.find((node) => node.source === source)?.paint;
      // overflow-x: clip is the one computed combination that clips a single
      // axis; every other single-axis value forces the other axis to auto.
      expect(paintOf("#single")).toMatchObject({ overflowX: "clip", overflowY: "visible", overflow: "visible" });
      // jsdom reports only the shorthand here, exercising the fallback that
      // real engines never need.
      expect(paintOf("#both")).toMatchObject({ overflowX: "auto", overflowY: "auto", overflow: "hidden" });
      expect(paintOf("#plain")).toMatchObject({ overflowX: "visible", overflowY: "visible", overflow: "visible" });
      const overflowDiagnostics = result.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_OVERFLOW");
      expect(overflowDiagnostics).toHaveLength(1);
      expect(overflowDiagnostics[0]).toMatchObject({ severity: "warning", source: "#single" });
      expect(overflowDiagnostics[0].message).toContain("clips only one axis");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalBounds;
      window.getComputedStyle = originalComputedStyle;
      Object.defineProperty(window, "CSS", { value: originalCss, configurable: true });
    }
  });

  it("captures decorated direct text at opacity one and imports it under the parent compositing opacity", async () => {
    document.body.innerHTML = `<div id="decorated" style="width:25px;height:15px;opacity:.5;visibility:visible;background-color:rgb(20, 40, 60)">Captured direct text</div>`;
    document.body.style.cssText = "opacity:1;visibility:visible";
    const decorated = document.querySelector("#decorated") as HTMLElement;
    const bounds = { x: 0, y: 0, left: 0, top: 0, right: 25, bottom: 15, width: 25, height: 15, toJSON: () => ({}) };
    const line = { x: 1, y: 1, left: 1, top: 1, right: 20, bottom: 11, width: 19, height: 10, toJSON: () => ({}) };
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    const originalComputedStyle = window.getComputedStyle;
    const originalCreateRange = document.createRange;
    const originalCss = window.CSS;
    HTMLElement.prototype.getBoundingClientRect = function () { return bounds; };
    window.getComputedStyle = ((element: Element) => originalComputedStyle.call(window, element)) as typeof window.getComputedStyle;
    document.createRange = (() => ({ selectNodeContents: () => undefined, setStart: () => undefined, setEnd: () => undefined, getClientRects: () => [line], getBoundingClientRect: () => line })) as unknown as typeof document.createRange;
    Object.defineProperty(window, "CSS", { value: { escape: (value: string) => value }, configurable: true });
    try {
      const captured = await captureScript("decorated-opacity");
      const parent = captured.nodes.find((node) => node.source === "#decorated");
      const text = captured.nodes.find((node) => node.source === "#decorated ::text");
      expect(parent).toMatchObject({ kind: "container", paint: { opacity: 0.5 } });
      expect(text).toMatchObject({ parentId: parent?.id, paint: { opacity: 1 } });

      const shape = (type: string) => ({ type, opacity: 1, fills: [] as unknown[], children: [] as Array<Record<string, unknown>>, resize: () => undefined, setPluginData: () => undefined, getPluginData: () => "", appendChild(child: Record<string, unknown>) { this.children.push(child); }, remove: () => undefined });
      const group = vi.fn((children: Array<Record<string, unknown>>) => ({ ...shape("group"), children }));
      vi.stubGlobal("penpot", {
        viewport: { center: { x: 0, y: 0 } },
        history: { undoBlockBegin: () => Symbol("undo"), undoBlockFinish: () => undefined },
        createBoard: () => ({ ...shape("board"), clipContent: true }),
        createRectangle: () => shape("rectangle"),
        createText: (characters: string) => ({ ...shape("text"), characters, growType: "fixed" }),
        group,
        createShapeFromSvg: () => null,
        createShapeFromSvgWithImages: () => null,
        uploadMediaData: async () => ({}),
        uploadMediaUrl: async () => ({})
      });
      await importScenes([captured], { isCancelled: () => false, onProgress: () => undefined });
      const imported = group.mock.results[0]?.value as { opacity: number; children: Array<{ type: string; opacity: number }> };
      expect(imported.opacity).toBe(0.5);
      expect(imported.children.find((child) => child.type === "text")?.opacity).toBe(1);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalBounds;
      window.getComputedStyle = originalComputedStyle;
      document.createRange = originalCreateRange;
      Object.defineProperty(window, "CSS", { value: originalCss, configurable: true });
      vi.unstubAllGlobals();
    }
  });
});
