import { afterEach, describe, expect, it } from "vitest";
import type { SceneDocument, SceneNode, ViewportSpec } from "../shared/contracts";
import { buildExtractorScript } from "./extractor";

const VIEWPORT: ViewportSpec = { id: "borders", name: "Borders", width: 400, height: 300 };
const SIDES = ["Top", "Right", "Bottom", "Left"] as const;
type Declared = Record<string, string>;

function borders(widths: number[], colors = ["rgb(1, 2, 3)", "rgb(1, 2, 3)", "rgb(1, 2, 3)", "rgb(1, 2, 3)"], styles = ["solid", "solid", "solid", "solid"]): Declared {
  return Object.fromEntries(SIDES.flatMap((side, index) => [
    [`border${side}Width`, `${widths[index]}px`],
    [`border${side}Color`, colors[index]],
    [`border${side}Style`, styles[index]]
  ]));
}

function captureScript(token: string): Promise<SceneDocument> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { window.removeEventListener("message", receive); window.clearTimeout(timeout); };
    const receive = (event: MessageEvent) => {
      if (event.data?.token !== token) return;
      cleanup();
      if (event.data.type === "CAPTURE_RESULT") resolve(event.data.scene as SceneDocument);
      else reject(new Error(event.data.message || "Capture failed."));
    };
    const timeout = window.setTimeout(() => { cleanup(); reject(new Error(`Capture ${token} did not complete.`)); }, 5_000);
    window.addEventListener("message", receive);
    try { window.eval(buildExtractorScript(token, VIEWPORT, 0)); } catch (error) { cleanup(); reject(error); }
  });
}

/** Supply browser-computed border values and layout boxes because jsdom does
 * not implement border layout or Range geometry. */
function installBrowser(declared: Record<string, Declared>): () => void {
  const originalBounds = HTMLElement.prototype.getBoundingClientRect;
  const originalStyle = window.getComputedStyle;
  const originalRange = document.createRange;
  const originalCss = window.CSS;
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this === document.body ? rect(0, 0, 400, 300) : rect(20, 10, 100, 40);
  };
  window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
    const style = Object.create(originalStyle.call(window, element)) as CSSStyleDeclaration;
    const defaults: Declared = { opacity: "1", visibility: "visible", backgroundColor: "transparent", backgroundImage: "none", boxShadow: "none", borderImageSource: "none", ...borders([0, 0, 0, 0], undefined, ["none", "none", "none", "none"]) };
    const overrides = pseudo ? { content: "none" } : declared[element.id];
    for (const [name, value] of Object.entries({ ...defaults, ...overrides })) Object.defineProperty(style, name, { value, configurable: true });
    return style;
  }) as typeof window.getComputedStyle;
  document.createRange = (() => ({
    selectNodeContents: () => undefined, setStart: () => undefined, setEnd: () => undefined,
    getClientRects: () => [rect(22, 12, 40, 12)], getBoundingClientRect: () => rect(22, 12, 40, 12)
  })) as unknown as typeof document.createRange;
  Object.defineProperty(window, "CSS", { value: { escape: (value: string) => value }, configurable: true });
  return () => {
    HTMLElement.prototype.getBoundingClientRect = originalBounds;
    window.getComputedStyle = originalStyle;
    document.createRange = originalRange;
    Object.defineProperty(window, "CSS", { value: originalCss, configurable: true });
  };
}

function bySource(scene: SceneDocument, source: string): SceneNode {
  const node = scene.nodes.find((candidate) => candidate.source === source);
  if (!node) throw new Error(`Missing scene node ${source}.`);
  return node;
}

describe("extractor borders", () => {
  let restore: (() => void) | undefined;
  afterEach(() => { restore?.(); restore = undefined; });

  it("captures all differing sides and preserves a bottom-bordered text element as a container", async () => {
    document.body.innerHTML = '<div id="label">Bottom border</div>';
    restore = installBrowser({ label: borders([0, 0, 3, 0], ["rgb(1, 2, 3)", "rgb(4, 5, 6)", "rgba(7, 8, 9, 0.5)", "rgb(10, 11, 12)"], ["none", "none", "solid", "none"]) });
    const scene = await captureScript("bottom-border-text");
    const label = bySource(scene, "#label");
    expect(label.kind).toBe("container");
    expect(label.paint.borders).toEqual({
      top: { color: "rgb(1, 2, 3)", width: 0, style: "none" },
      right: { color: "rgb(4, 5, 6)", width: 0, style: "none" },
      bottom: { color: "rgba(7, 8, 9, 0.5)", width: 3, style: "solid" },
      left: { color: "rgb(10, 11, 12)", width: 0, style: "none" }
    });
    expect(label.paint.borderColor).toBeUndefined();
    expect(label.paint.borderWidth).toBeUndefined();
    expect(label.paint.borderStyle).toBeUndefined();
    expect(scene.nodes.some((node) => node.parentId === label.id && node.kind === "text" && node.text === "Bottom border")).toBe(true);
  });

  it("retains the legacy uniform border representation for supported native styles", async () => {
    document.body.innerHTML = '<div id="solid"></div><div id="dashed"></div><div id="dotted"></div>';
    restore = installBrowser(Object.fromEntries(["solid", "dashed", "dotted"].map((style) => [style, borders([2, 2, 2, 2], undefined, [style, style, style, style])])));
    const scene = await captureScript("uniform-borders");
    for (const style of ["solid", "dashed", "dotted"]) {
      expect(bySource(scene, `#${style}`).paint).toMatchObject({ borderColor: "rgb(1, 2, 3)", borderWidth: 2, borderStyle: style });
      expect(bySource(scene, `#${style}`).paint.borders).toBeUndefined();
    }
    expect(scene.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("UNSUPPORTED_BORDER"))).toEqual([]);
  });

  it("captures color-only or style-only differences even when all side widths match", async () => {
    document.body.innerHTML = '<div id="colors"></div><div id="styles"></div>';
    restore = installBrowser({
      colors: borders([2, 2, 2, 2], ["rgb(1, 2, 3)", "rgb(4, 5, 6)", "rgb(1, 2, 3)", "rgb(1, 2, 3)"]),
      styles: borders([2, 2, 2, 2], undefined, ["solid", "dashed", "solid", "solid"])
    });
    const scene = await captureScript("border-differences");
    expect(bySource(scene, "#colors").paint.borders?.right.color).toBe("rgb(4, 5, 6)");
    expect(bySource(scene, "#styles").paint.borders?.right.style).toBe("dashed");
  });

  it("scales every side width with its transformed layer", async () => {
    document.body.innerHTML = '<div id="scaled"></div>';
    restore = installBrowser({ scaled: { ...borders([1, 2, 3, 0]), transform: "matrix(2, 0, 0, 2, 10, 5)", transformOrigin: "0px 0px" } });
    const scaled = bySource(await captureScript("scaled-borders"), "#scaled");
    expect(scaled.rect).toEqual({ x: 30, y: 15, width: 200, height: 80 });
    expect(Object.values(scaled.paint.borders ?? {}).map((border) => border.width)).toEqual([2, 4, 6, 0]);
  });

  it("reports unsupported colors on every active side and ignores zero-width or hidden sides", async () => {
    document.body.innerHTML = '<div id="modern"></div>';
    restore = installBrowser({ modern: borders([0, 2, 3, 4], Array(4).fill("color(display-p3 1 0 0)"), ["solid", "solid", "solid", "hidden"]) });
    const scene = await captureScript("side-colors");
    const diagnostics = scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_COLOR_FORMAT");
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringContaining("right border color"), expect.stringContaining("bottom border color")
    ]);
    expect(diagnostics.every((diagnostic) => diagnostic.source === "#modern")).toBe(true);
  });

  it("diagnoses unsupported styles on individual sides", async () => {
    document.body.innerHTML = '<div id="mixed"></div>';
    restore = installBrowser({ mixed: borders([2, 2, 3, 4], undefined, ["solid", "dashed", "double", "hidden"]) });
    const diagnostics = (await captureScript("side-styles")).diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_BORDER_STYLE");
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringContaining("right border"), expect.stringContaining("bottom border")
    ]);
  });

  it("diagnoses unsupported uniform styles", async () => {
    document.body.innerHTML = '<div id="double"></div>';
    restore = installBrowser({ double: borders([3, 3, 3, 3], undefined, ["double", "double", "double", "double"]) });
    const diagnostics = (await captureScript("uniform-double")).diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_BORDER_STYLE");
    expect(diagnostics).toEqual([expect.objectContaining({ source: "#double", message: expect.stringContaining("double") })]);
  });

  it("diagnoses rounded differing borders while retaining the background corner radii", async () => {
    document.body.innerHTML = '<div id="rounded"></div>';
    restore = installBrowser({ rounded: { ...borders([1, 2, 3, 4]), borderTopLeftRadius: "8px", borderTopRightRadius: "10px", borderBottomRightRadius: "12px", borderBottomLeftRadius: "14px" } });
    const scene = await captureScript("rounded-sides");
    expect(bySource(scene, "#rounded").paint.radius).toEqual([8, 10, 12, 14]);
    expect(scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_BORDER_RADIUS")).toEqual([expect.objectContaining({ source: "#rounded" })]);
  });

  it("diagnoses border images and preserves their ordinary border fallback", async () => {
    document.body.innerHTML = '<div id="image"></div>';
    restore = installBrowser({ image: { ...borders([5, 5, 5, 5]), borderImageSource: 'url("https://example.com/border.png")' } });
    const scene = await captureScript("border-image");
    expect(bySource(scene, "#image").paint).toMatchObject({ borderColor: "rgb(1, 2, 3)", borderWidth: 5, borderStyle: "solid" });
    expect(scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_BORDER_IMAGE")).toEqual([expect.objectContaining({ source: "#image" })]);
  });
});
