import { afterEach, describe, expect, it } from "vitest";
import type { SceneDocument, SceneNode, ViewportSpec } from "../shared/contracts";
import { buildExtractorScript } from "./extractor";

const VIEWPORT: ViewportSpec = { id: "images", name: "Images", width: 400, height: 300 };
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
  for (const image of document.images) {
    Object.defineProperty(image, "naturalWidth", { value: image.id === "broken" ? 0 : image.id === "large" ? 10000 : 240, configurable: true });
    Object.defineProperty(image, "naturalHeight", { value: image.id === "broken" ? 0 : image.id === "large" ? 5000 : 120, configurable: true });
  }
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

describe("extractor image fit and position", () => {
  let restore: (() => void) | undefined;
  afterEach(() => { restore?.(); restore = undefined; });

  it.each(["fill", "contain", "cover", "none", "scale-down"])("captures %s and natural CSS dimensions", async (fit) => {
    document.body.innerHTML = '<img id="photo" src="https://example.test/photo.png">';
    restore = installBrowser({ photo: { objectFit: fit, objectPosition: "50% 50%" } });
    const scene = await captureScript(`fit-${fit}`);
    expect(bySource(scene, "#photo").image).toEqual({ fit, intrinsicWidth: 240, intrinsicHeight: 120,
      position: { x: { percentage: 0.5, offset: 0 }, y: { percentage: 0.5, offset: 0 } } });
    expect(scene.diagnostics.filter((diagnostic) => diagnostic.code.includes("OBJECT") || diagnostic.code.includes("IMAGE_DIMENSIONS"))).toEqual([]);
  });

  it.each([
    ["25% 75%", 0.25, 0, 0.75, 0],
    ["12px 8px", 0, 12, 0, 8],
    ["left top", 0, 0, 0, 0],
    ["bottom right", 1, 0, 1, 0],
    ["center", 0.5, 0, 0.5, 0],
    ["top", 0.5, 0, 0, 0],
    ["right 12px bottom 8px", 1, -12, 1, -8],
    ["bottom 8px left 20%", 0.2, 0, 1, -8],
    ["center bottom 8px", 0.5, 0, 1, -8],
    ["right 12px top", 1, -12, 0, 0],
    ["calc(100% - 12px) calc(25% + 8px)", 1, -12, 0.25, 8],
    ["calc(12px + 25%) 0", 0.25, 12, 0, 0],
    ["-25% 120%", -0.25, 0, 1.2, 0]
  ])("resolves %s without losing percentages or offsets", async (position, xPercent, xOffset, yPercent, yOffset) => {
    document.body.innerHTML = '<img id="photo" src="https://example.test/photo.png">';
    restore = installBrowser({ photo: { objectFit: "cover", objectPosition: String(position) } });
    const scene = await captureScript(`position-${position}`);
    expect(bySource(scene, "#photo").image?.position).toEqual({
      x: { percentage: xPercent, offset: xOffset }, y: { percentage: yPercent, offset: yOffset }
    });
    expect(scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_OBJECT_POSITION")).toEqual([]);
  });

  it("scales fixed offsets and natural rendering size with the composed frame", async () => {
    document.body.innerHTML = '<img id="photo" src="https://example.test/photo.png">';
    restore = installBrowser({ photo: { objectFit: "none", objectPosition: "calc(100% - 12px) 8px", transform: "matrix(2, 0, 0, 2, 10, 5)", transformOrigin: "0px 0px", paddingTop: "4px", paddingRight: "4px", paddingBottom: "4px", paddingLeft: "4px", ...borders([2, 2, 2, 2]) } });
    const photo = bySource(await captureScript("scaled-image"), "#photo");
    expect(photo.rect).toEqual({ x: 30, y: 15, width: 200, height: 80 });
    expect(photo.image).toMatchObject({ intrinsicWidth: 240, intrinsicHeight: 120, scale: 2,
      position: { x: { percentage: 1, offset: -24 }, y: { percentage: 0, offset: 16 } } });
    expect(photo.layout.padding).toEqual([8, 8, 8, 8]);
    expect(photo.paint.borderWidth).toBe(4);
  });

  it("retains image scale and offset precision for near-identity transforms", async () => {
    document.body.innerHTML = '<img id="large" src="https://example.test/large.png">';
    restore = installBrowser({ large: { objectFit: "none", objectPosition: "10000px 8px", transform: "matrix(1.00005, 0, 0, 1.00005, 0, 0)", transformOrigin: "0px 0px" } });
    const metadata = bySource(await captureScript("near-identity-image"), "#large").image!;
    expect(metadata.scale).toBeCloseTo(1.00005, 10);
    expect(metadata.intrinsicWidth * metadata.scale!).toBeCloseTo(10000.5, 8);
    expect(metadata.position.x.offset).toBeCloseTo(10000.5, 8);
    expect(metadata.position.y.offset).toBeCloseTo(8.0004, 8);
  });

  it("deduplicates the source while keeping image placement per element", async () => {
    document.body.innerHTML = '<img id="first" src="https://example.test/photo.png"><img id="second" src="https://example.test/photo.png">';
    restore = installBrowser({ first: { objectFit: "contain" }, second: { objectFit: "cover" } });
    const scene = await captureScript("shared-image");
    expect(scene.assets).toHaveLength(1);
    expect(bySource(scene, "#first").assetId).toBe(bySource(scene, "#second").assetId);
    expect(bySource(scene, "#first").image?.fit).toBe("contain");
    expect(bySource(scene, "#second").image?.fit).toBe("cover");
  });

  it("retains a broken image for the existing named placeholder", async () => {
    document.body.innerHTML = '<img id="broken" src="https://example.test/missing.png">';
    restore = installBrowser({ broken: { objectFit: "cover" } });
    const scene = await captureScript("broken-image");
    expect(bySource(scene, "#broken")).toMatchObject({ kind: "image", assetId: expect.any(String) });
    expect(bySource(scene, "#broken").image).toBeUndefined();
    expect(scene.diagnostics).toContainEqual(expect.objectContaining({ code: "IMAGE_DIMENSIONS_UNAVAILABLE", source: "#broken" }));
  });

  it("diagnoses unsupported positions while preserving fit with a centered fallback", async () => {
    document.body.innerHTML = '<img id="photo" src="https://example.test/photo.png">';
    restore = installBrowser({ photo: { objectFit: "cover", objectPosition: "min(10px, 20%) 50%" } });
    const scene = await captureScript("unsupported-position");
    expect(bySource(scene, "#photo").image).toMatchObject({ fit: "cover", position: {
      x: { percentage: 0.5, offset: 0 }, y: { percentage: 0.5, offset: 0 }
    } });
    expect(scene.diagnostics).toContainEqual(expect.objectContaining({ code: "UNSUPPORTED_OBJECT_POSITION", source: "#photo" }));
  });
});
