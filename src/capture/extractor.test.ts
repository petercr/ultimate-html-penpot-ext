import { describe, expect, it } from "vitest";
import { buildExtractorScript } from "./extractor";

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
    expect(script).toContain('style.backgroundColor !== "rgba(0, 0, 0, 0)"');
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
    const messages: MessageEvent[] = [];
    const receive = (event: MessageEvent) => messages.push(event);
    window.addEventListener("message", receive);
    try {
      window.eval(buildExtractorScript("anchor-test", { id: "test", name: "Test", width: 25, height: 15 }, 0));
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      window.removeEventListener("message", receive);
      HTMLElement.prototype.getBoundingClientRect = originalBounds;
      window.getComputedStyle = originalComputedStyle;
      Object.defineProperty(window, "CSS", { value: originalCss, configurable: true });
    }
    const result = messages.find((event) => event.data?.type === "CAPTURE_RESULT")?.data?.scene;
    const node = result?.nodes?.find((candidate: { source: string }) => candidate.source === "#anchor");
    const asset = node && result.assets.find((candidate: { id: string }) => candidate.id === node.assetId);
    expect(result).toBeDefined();
    expect(node).toBeDefined();
    expect(asset?.dataUrl).toContain("data:image/svg+xml,");
    const materialized = decodeURIComponent((asset?.dataUrl || "").split(",", 2)[1]);
    expect(materialized).toContain('viewBox="0 0 25 15"');
    expect(materialized.match(/<g /g)?.length).toBe(6);
    expect(materialized).toContain("translate(0 0)");
    expect(materialized).toContain("translate(20 10)");
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
    const messages: MessageEvent[] = [];
    const receive = (event: MessageEvent) => messages.push(event);
    window.addEventListener("message", receive);
    try {
      window.eval(buildExtractorScript("layered-test", { id: "test", name: "Test", width: 25, height: 15 }, 0));
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      window.removeEventListener("message", receive);
      HTMLElement.prototype.getBoundingClientRect = originalBounds;
      window.getComputedStyle = originalComputedStyle;
      Object.defineProperty(window, "CSS", { value: originalCss, configurable: true });
    }
    const result = messages.find((event) => event.data?.type === "CAPTURE_RESULT")?.data?.scene;
    const node = result?.nodes?.find((candidate: { source: string }) => candidate.source === "#layered");
    expect(node?.paint.backgroundImage).toMatch(/^linear-gradient/);
    expect(result?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MULTIPLE_BACKGROUND_LAYERS", source: "#layered" })
    ]));
  });
});
