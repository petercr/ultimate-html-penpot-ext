import { afterEach, describe, expect, it } from "vitest";
import type { SceneDocument, SceneNode, ViewportSpec } from "../shared/contracts";
import { buildExtractorScript } from "./extractor";

const VIEWPORT: ViewportSpec = { id: "test", name: "Test", width: 400, height: 300 };
const IDENTITY = "matrix(1, 0, 0, 1, 0, 0)";

interface Box { x: number; y: number; width: number; height: number }
/** Computed values this double reports for an element; jsdom does not derive them from the cascade. */
type Declared = Record<string, string>;

const toRect = ({ x, y, width, height }: Box) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });

function rotation(degrees: number): string {
  const radians = degrees * Math.PI / 180;
  const cos = Math.cos(radians).toFixed(6);
  const sin = Math.sin(radians).toFixed(6);
  return `matrix(${cos}, ${sin}, ${(-Number(sin)).toFixed(6)}, ${cos}, 0, 0)`;
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

/**
 * A browser double for transform capture. An element reports its layout box
 * unless it still carries a declared transform, in which case it reports the
 * configured transformed bounds, exactly as a browser reports the bounding box
 * of a transformed element. Capture neutralizes supported transforms with an
 * identity matrix, which is what makes the layout box visible.
 */
function installBrowser(layout: Record<string, Box>, declared: Record<string, Declared> = {}, visual: Record<string, Box> = {}, line?: Box): () => void {
  const originalBounds = HTMLElement.prototype.getBoundingClientRect;
  const originalComputedStyle = window.getComputedStyle;
  const originalCreateRange = document.createRange;
  const originalCss = window.CSS;
  const identify = (element: Element) => element.id || (element === document.body ? "body" : "");
  HTMLElement.prototype.getBoundingClientRect = function () {
    const id = identify(this);
    const neutral = this.style.getPropertyValue("transform") === IDENTITY;
    const transformed = Boolean(declared[id]) && !neutral && visual[id];
    return toRect(transformed ? visual[id] : layout[id] ?? { x: 0, y: 0, width: 0, height: 0 });
  };
  window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
    const style = Object.create(originalComputedStyle.call(window, element)) as CSSStyleDeclaration;
    const overrides = pseudo ? undefined : declared[identify(element)];
    for (const [name, value] of Object.entries(overrides ?? {})) Object.defineProperty(style, name, { value, configurable: true });
    return style;
  }) as typeof window.getComputedStyle;
  document.createRange = (() => ({
    selectNodeContents: () => undefined, setStart: () => undefined, setEnd: () => undefined,
    getClientRects: () => (line ? [toRect(line)] : []), getBoundingClientRect: () => toRect(line ?? { x: 0, y: 0, width: 0, height: 0 })
  })) as unknown as typeof document.createRange;
  Object.defineProperty(window, "CSS", { value: { escape: (value: string) => value }, configurable: true });
  return () => {
    HTMLElement.prototype.getBoundingClientRect = originalBounds;
    window.getComputedStyle = originalComputedStyle;
    document.createRange = originalCreateRange;
    Object.defineProperty(window, "CSS", { value: originalCss, configurable: true });
  };
}

const VISIBLE = "opacity:1;visibility:visible";
const bySource = (scene: SceneDocument, source: string): SceneNode => {
  const node = scene.nodes.find((candidate) => candidate.source === source);
  if (!node) throw new Error(`Missing scene node ${source}.`);
  return node;
};

describe("extractor transforms", () => {
  let restore: (() => void) | undefined;
  afterEach(() => { restore?.(); restore = undefined; });

  it("keeps a rotated layer's own size and moves its corner to the rotated position", async () => {
    document.body.innerHTML = `<div id="card" style="${VISIBLE}"></div>`;
    document.body.style.cssText = VISIBLE;
    restore = installBrowser({ body: { x: 0, y: 0, width: 400, height: 300 }, card: { x: 100, y: 50, width: 100, height: 40 } },
      { card: { transform: rotation(90), transformOrigin: "50px 20px" } },
      { card: { x: 130, y: 20, width: 40, height: 100 } });
    const scene = await captureScript("rotated");
    const card = bySource(scene, "#card");
    // The center (150, 70) is fixed; the top-left corner turns clockwise to (170, 20).
    expect(card.rect).toEqual({ x: 170, y: 20, width: 100, height: 40 });
    expect(card.rotation).toBe(90);
    expect((document.querySelector("#card") as HTMLElement).style.getPropertyValue("transform")).toBe(IDENTITY);
    expect(scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_TRANSFORM")).toEqual([]);
  });

  it("moves text lines with the rotated element that contains them", async () => {
    document.body.innerHTML = `<div id="card" style="${VISIBLE}">Hello</div>`;
    document.body.style.cssText = VISIBLE;
    restore = installBrowser({ body: { x: 0, y: 0, width: 400, height: 300 }, card: { x: 100, y: 50, width: 100, height: 40 } },
      { card: { transform: rotation(90), transformOrigin: "50px 20px" } }, {}, { x: 102, y: 52, width: 40, height: 12 });
    const scene = await captureScript("rotated-text");
    const text = scene.nodes.find((node) => node.kind === "text");
    expect(text?.rect).toEqual({ x: 168, y: 22, width: 40, height: 12 });
    expect(text?.rotation).toBe(90);
  });

  it("applies translation and uniform scale to boxes, text, borders, and radii", async () => {
    document.body.innerHTML = `<div id="zoom" style="${VISIBLE};font-size:10px;border:2px solid rgb(1, 2, 3)">Hi</div>`;
    document.body.style.cssText = VISIBLE;
    restore = installBrowser({ body: { x: 0, y: 0, width: 400, height: 300 }, zoom: { x: 20, y: 10, width: 30, height: 10 } },
      { zoom: { transform: "matrix(2, 0, 0, 2, 10, 5)", transformOrigin: "0px 0px", borderTopLeftRadius: "4px", borderTopRightRadius: "4px", borderBottomRightRadius: "4px", borderBottomLeftRadius: "4px" } }, {}, { x: 22, y: 12, width: 12, height: 8 });
    const scene = await captureScript("scaled");
    const zoom = bySource(scene, "#zoom");
    expect(zoom.rect).toEqual({ x: 30, y: 15, width: 60, height: 20 });
    expect(zoom.rotation).toBeUndefined();
    expect(zoom.paint.borderWidth).toBe(4);
    expect(zoom.paint.radius).toEqual([8, 8, 8, 8]);
    const text = scene.nodes.find((node) => node.kind === "text");
    expect(text?.rect).toEqual({ x: 34, y: 19, width: 24, height: 16 });
    expect(text?.textStyle?.fontSize).toBe(20);
  });

  it("composes nested rotations in layout space", async () => {
    document.body.innerHTML = `<div id="outer" style="${VISIBLE}"><div id="inner" style="${VISIBLE}"></div></div>`;
    document.body.style.cssText = VISIBLE;
    restore = installBrowser({ body: { x: 0, y: 0, width: 400, height: 300 }, outer: { x: 0, y: 0, width: 200, height: 100 }, inner: { x: 20, y: 20, width: 60, height: 20 } },
      { outer: { transform: rotation(10), transformOrigin: "100px 50px" }, inner: { transform: rotation(20), transformOrigin: "30px 10px" } });
    const scene = await captureScript("nested");
    expect(bySource(scene, "#outer").rotation).toBe(10);
    const inner = bySource(scene, "#inner");
    expect(inner.rotation).toBe(30);
    expect(inner.rect.width).toBe(60);
    expect(inner.rect.height).toBe(20);
    // The inner center (50, 30) is turned 10 degrees about the outer center (100, 50).
    const radians = 10 * Math.PI / 180;
    const center = { x: 100 + (50 - 100) * Math.cos(radians) - (30 - 50) * Math.sin(radians), y: 50 + (50 - 100) * Math.sin(radians) + (30 - 50) * Math.cos(radians) };
    const corner = { x: center.x + (-30 * Math.cos(30 * Math.PI / 180) + 10 * Math.sin(30 * Math.PI / 180)), y: center.y + (-30 * Math.sin(30 * Math.PI / 180) - 10 * Math.cos(30 * Math.PI / 180)) };
    expect(inner.rect.x).toBeCloseTo(corner.x, 1);
    expect(inner.rect.y).toBeCloseTo(corner.y, 1);
  });

  it("composes the translate, rotate, and scale properties before transform", async () => {
    document.body.innerHTML = `<div id="props" style="${VISIBLE}"></div>`;
    document.body.style.cssText = VISIBLE;
    restore = installBrowser({ body: { x: 0, y: 0, width: 400, height: 300 }, props: { x: 0, y: 0, width: 10, height: 6 } },
      { props: { translate: "8px 4px", rotate: "90deg", scale: "2", transformOrigin: "5px 3px" } });
    const props = bySource(await captureScript("properties"), "#props");
    expect(props.rect.x).toBeCloseTo(19, 5);
    expect(props.rect.y).toBeCloseTo(-3, 5);
    expect(props.rect.width).toBe(20);
    expect(props.rect.height).toBe(12);
    expect(props.rotation).toBe(90);
  });

  it("resolves translate percentages against the layer's own box", async () => {
    document.body.innerHTML = `<div id="shift" style="${VISIBLE}"></div>`;
    document.body.style.cssText = VISIBLE;
    restore = installBrowser({ body: { x: 0, y: 0, width: 400, height: 300 }, shift: { x: 10, y: 10, width: 100, height: 40 } },
      { shift: { translate: "50% -25%", transformOrigin: "50px 20px" } });
    const shift = bySource(await captureScript("percent-translate"), "#shift");
    // 50% of the 100px width and -25% of the 40px height.
    expect(shift.rect).toEqual({ x: 60, y: 0, width: 100, height: 40 });
    expect(shift.rotation).toBeUndefined();
  });

  it.each([
    ["calc() translate", { translate: "calc(10% + 5px) 0px" }],
    ["3D translate", { translate: "1px 2px 3px" }],
    ["axis rotate", { rotate: "1 0 0 30deg" }],
    ["3D scale", { scale: "1 1 2" }]
  ])("keeps the transformed bounds of an element with a %s property and reports it", async (_name, declared) => {
    document.body.innerHTML = `<div id="odd" style="${VISIBLE}"></div>`;
    document.body.style.cssText = VISIBLE;
    restore = installBrowser({ body: { x: 0, y: 0, width: 400, height: 300 }, odd: { x: 10, y: 10, width: 100, height: 40 } },
      { odd: { ...declared, transformOrigin: "50px 20px" } }, { odd: { x: 5, y: 8, width: 130, height: 44 } });
    const scene = await captureScript("unsupported-properties");
    expect(bySource(scene, "#odd").rect).toEqual({ x: 5, y: 8, width: 130, height: 44 });
    expect(bySource(scene, "#odd").rotation).toBeUndefined();
    expect(scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_TRANSFORM")).toEqual([
      expect.objectContaining({ severity: "warning", source: "#odd" })
    ]);
  });

  it.each([
    ["skew", "matrix(1, 0, 0.36397, 1, 0, 0)"],
    ["non-uniform scale", "matrix(2, 0, 0, 1, 0, 0)"],
    ["mirror", "matrix(-1, 0, 0, 1, 0, 0)"],
    ["3D rotation", "matrix3d(1, 0, 0, 0, 0, 0.8, 0.6, 0, 0, -0.6, 0.8, 0, 0, 0, 0, 1)"]
  ])("keeps the transformed bounds of an element with a %s and reports it", async (_name, transform) => {
    document.body.innerHTML = `<div id="odd" style="${VISIBLE}"><div id="child" style="${VISIBLE}"></div></div>`;
    document.body.style.cssText = VISIBLE;
    restore = installBrowser({ body: { x: 0, y: 0, width: 400, height: 300 }, odd: { x: 10, y: 10, width: 100, height: 40 }, child: { x: 10, y: 10, width: 20, height: 10 } },
      { odd: { transform, transformOrigin: "50px 20px" } },
      { odd: { x: 5, y: 8, width: 130, height: 44 }, child: { x: 6, y: 9, width: 24, height: 12 } });
    const scene = await captureScript("unsupported");
    expect(bySource(scene, "#odd").rect).toEqual({ x: 5, y: 8, width: 130, height: 44 });
    expect(bySource(scene, "#odd").rotation).toBeUndefined();
    expect((document.querySelector("#odd") as HTMLElement).style.getPropertyValue("transform")).toBe("");
    expect(scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_TRANSFORM")).toEqual([
      expect.objectContaining({ severity: "warning", source: "#odd" })
    ]);
  });

  it("imports nothing for an element collapsed by its transform", async () => {
    document.body.innerHTML = `<div id="gone" style="${VISIBLE}"><div id="inside" style="${VISIBLE}"></div></div>`;
    document.body.style.cssText = VISIBLE;
    restore = installBrowser({ body: { x: 0, y: 0, width: 400, height: 300 }, gone: { x: 10, y: 10, width: 100, height: 40 }, inside: { x: 10, y: 10, width: 20, height: 10 } },
      { gone: { transform: "matrix(0, 0, 0, 0, 0, 0)", transformOrigin: "50px 20px" } });
    const scene = await captureScript("collapsed");
    expect(scene.nodes.map((node) => node.source)).toEqual(["body"]);
    expect(scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_TRANSFORM")).toEqual([]);
  });

  it("ignores the transform of an inline box that the browser cannot transform", async () => {
    document.body.innerHTML = `<p id="para" style="${VISIBLE}"><span id="inline" style="${VISIBLE}">word</span></p>`;
    document.body.style.cssText = VISIBLE;
    restore = installBrowser({ body: { x: 0, y: 0, width: 400, height: 300 }, para: { x: 0, y: 0, width: 200, height: 20 }, inline: { x: 10, y: 2, width: 40, height: 16 } },
      { inline: { display: "inline", transform: rotation(40), transformOrigin: "20px 8px" } }, {}, { x: 10, y: 2, width: 40, height: 16 });
    const scene = await captureScript("inline");
    const inline = scene.nodes.find((node) => node.source.startsWith("#inline"));
    expect(inline?.rotation).toBeUndefined();
    expect(inline?.rect).toEqual({ x: 10, y: 2, width: 40, height: 16 });
    expect(scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_TRANSFORM")).toEqual([]);
  });

  it("leaves untransformed layers exactly as measured", async () => {
    document.body.innerHTML = `<div id="plain" style="${VISIBLE}"></div>`;
    document.body.style.cssText = VISIBLE;
    restore = installBrowser({ body: { x: 0, y: 0, width: 400, height: 300 }, plain: { x: 12.5, y: 7, width: 30, height: 10 } });
    const plain = bySource(await captureScript("plain"), "#plain");
    expect(plain.rect).toEqual({ x: 12.5, y: 7, width: 30, height: 10 });
    expect(plain.rotation).toBeUndefined();
    expect("transform" in plain.paint).toBe(false);
  });
});
