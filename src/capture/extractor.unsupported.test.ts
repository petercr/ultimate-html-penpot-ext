import { afterEach, describe, expect, it } from "vitest";
import type { SceneDocument } from "../shared/contracts";
import { buildExtractorScript } from "./extractor";

const VIEWPORT = { id: "unsupported", name: "Unsupported", width: 400, height: 300 };
type Declared = Record<string, string>;

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

/** Supply browser-computed values and layout boxes; jsdom implements neither. */
function installBrowser(declared: Record<string, Declared>, layout: Record<string, Declared> = {}): () => void {
  const originalBounds = HTMLElement.prototype.getBoundingClientRect;
  const originalStyle = window.getComputedStyle;
  const originalRange = document.createRange;
  const originalCss = window.CSS;
  const sizeNames = ["scrollWidth", "scrollHeight", "clientWidth", "clientHeight"] as const;
  const originalSizes = sizeNames.map((name) => [name, Object.getOwnPropertyDescriptor(Element.prototype, name)] as const);
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this === document.body ? rect(0, 0, 400, 300) : rect(20, 10, 100, 40);
  };
  // Element sizes for the truncation checks.
  for (const name of sizeNames) Object.defineProperty(Element.prototype, name, { configurable: true, get() { return Number(layout[(this as Element).id]?.[name] ?? 0); } });
  window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
    const style = Object.create(originalStyle.call(window, element)) as CSSStyleDeclaration;
    const defaults: Declared = {
      display: "block", opacity: "1", visibility: "visible", backgroundColor: "transparent", backgroundImage: "none", boxShadow: "none",
      borderImageSource: "none", borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none",
      color: "rgb(1, 2, 3)", outlineStyle: "none", outlineWidth: "0px", outlineColor: "rgb(1, 2, 3)", clipPath: "none", backgroundClip: "border-box",
      backgroundBlendMode: "normal", textShadow: "none", textDecorationLine: "none", textDecorationStyle: "solid", textDecorationColor: "rgb(1, 2, 3)",
      writingMode: "horizontal-tb", direction: "ltr", textOverflow: "clip", webkitLineClamp: "none", listStyleType: "disc"
    };
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
    for (const [name, descriptor] of originalSizes) {
      if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
      else delete (Element.prototype as unknown as Record<string, unknown>)[name];
    }
    Object.defineProperty(window, "CSS", { value: originalCss, configurable: true });
  };
}

const codes = (scene: SceneDocument) => scene.diagnostics.map((diagnostic) => diagnostic.code);

describe("unsupported CSS diagnostics", () => {
  let restore: (() => void) | undefined;
  afterEach(() => { restore?.(); restore = undefined; });

  it("reports box effects the snapshot cannot reproduce, once per code with the first source", async () => {
    document.body.innerHTML = '<div id="ring"></div><div id="layered"></div><div id="shape"></div><div id="knockout">Text</div><div id="blend"></div>';
    restore = installBrowser({
      ring: { outlineStyle: "solid", outlineWidth: "3px", outlineColor: "rgb(37, 99, 235)" },
      layered: { boxShadow: "rgba(0, 0, 0, 0.2) 0px 4px 6px -1px, rgba(0, 0, 0, 0.1) 0px 2px 4px -2px" },
      shape: { clipPath: "polygon(50% 0%, 100% 100%, 0% 100%)" },
      knockout: { backgroundClip: "text" },
      blend: { backgroundBlendMode: "multiply, normal" }
    });
    const scene = await captureScript("box-effects");
    expect(codes(scene)).toEqual(["UNSUPPORTED_OUTLINE", "MULTIPLE_BOX_SHADOWS", "UNSUPPORTED_CLIP_PATH", "UNSUPPORTED_BACKGROUND_CLIP", "UNSUPPORTED_BACKGROUND_BLEND_MODE"]);
    expect(scene.diagnostics.map((diagnostic) => diagnostic.source)).toEqual(["#ring", "#layered", "#shape", "#knockout", "#blend"]);
    expect(scene.nodes.some((node) => node.kind === "fallback")).toBe(false);
  });

  it("ignores invisible outlines, a single shadow, and unclipped backgrounds", async () => {
    document.body.innerHTML = '<div id="none"></div><div id="clear"></div><div id="single"></div>';
    restore = installBrowser({
      none: { outlineStyle: "none", outlineWidth: "3px" },
      clear: { outlineStyle: "solid", outlineWidth: "2px", outlineColor: "rgba(0, 0, 0, 0)" },
      single: { boxShadow: "rgba(0, 0, 0, 0.2) 0px 2px 6px 0px" }
    });
    expect(codes(await captureScript("no-box-effects"))).toEqual([]);
  });

  it("reports text effects only for elements that have text", async () => {
    document.body.innerHTML = '<div id="shadow">Shadow</div><div id="empty"></div><div id="wavy">Wavy</div><div id="plain-underline">Line</div><div id="vertical">V</div><div id="rtl">R</div>';
    restore = installBrowser({
      shadow: { textShadow: "rgb(148, 163, 184) 3px 3px 0px" },
      empty: { textShadow: "rgb(148, 163, 184) 3px 3px 0px" },
      wavy: { textDecorationLine: "underline", textDecorationStyle: "wavy" },
      "plain-underline": { textDecorationLine: "underline" },
      vertical: { writingMode: "vertical-rl" },
      rtl: { direction: "rtl" }
    });
    const scene = await captureScript("text-effects");
    expect(codes(scene)).toEqual(["UNSUPPORTED_TEXT_SHADOW", "UNSUPPORTED_TEXT_DECORATION", "UNSUPPORTED_WRITING_MODE"]);
    expect(scene.diagnostics.find((diagnostic) => diagnostic.code === "UNSUPPORTED_WRITING_MODE")?.message).toContain("Affects 2 elements");
    expect(scene.diagnostics.find((diagnostic) => diagnostic.code === "UNSUPPORTED_TEXT_SHADOW")?.source).toBe("#shadow");
  });

  it("flags a decoration drawn in a color other than the text color, and an overline", async () => {
    document.body.innerHTML = '<div id="colored">Colored</div><div id="over">Over</div>';
    restore = installBrowser({
      colored: { textDecorationLine: "underline", textDecorationColor: "rgb(220, 38, 38)" },
      over: { textDecorationLine: "overline" }
    });
    const scene = await captureScript("decoration-variants");
    expect(scene.diagnostics.find((diagnostic) => diagnostic.code === "UNSUPPORTED_TEXT_DECORATION")?.message).toContain("Affects 2 elements");
  });

  it("reports truncation only when the browser actually cut the text", async () => {
    document.body.innerHTML = '<div id="cut">A long sentence</div><div id="fits">Short</div><div id="clamped">Many lines of text</div>';
    restore = installBrowser({
      cut: { textOverflow: "ellipsis", overflowX: "hidden" },
      fits: { textOverflow: "ellipsis", overflowX: "hidden" },
      clamped: { webkitLineClamp: "2" }
    }, {
      cut: { scrollWidth: "300", clientWidth: "200" },
      fits: { scrollWidth: "100", clientWidth: "200" },
      clamped: { scrollHeight: "90", clientHeight: "40" }
    });
    const scene = await captureScript("truncation");
    const truncation = scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_TEXT_TRUNCATION");
    expect(truncation).toHaveLength(1);
    expect(truncation[0].message).toContain("Affects 2 elements");
    expect(truncation[0].source).toBe("#cut");
  });

  it("counts repeated list markers and form controls instead of listing each", async () => {
    document.body.innerHTML = '<ul id="items"><li id="a">One</li><li id="b">Two</li><li id="c">Three</li></ul><input id="typed" value="x"><input id="secret" type="hidden"><select id="pick"></select>';
    restore = installBrowser({
      a: { display: "list-item" }, b: { display: "list-item" }, c: { display: "list-item" },
      typed: { display: "inline-block" }, secret: { display: "inline-block" }, pick: { display: "inline-block" }
    });
    const scene = await captureScript("repeats");
    const marker = scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_LIST_MARKER");
    expect(marker).toHaveLength(1);
    expect(marker[0].message).toContain("Affects 3 elements, including #a, #b, #c");
    const controls = scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_FORM_CONTROL");
    expect(controls).toHaveLength(1);
    expect(controls[0].message).toContain("Affects 2 elements");
  });

  it("does not report list items whose marker is none", async () => {
    document.body.innerHTML = '<ul><li id="plain">One</li></ul>';
    restore = installBrowser({ plain: { display: "list-item", listStyleType: "none" } });
    expect(codes(await captureScript("no-marker"))).toEqual([]);
  });
});
