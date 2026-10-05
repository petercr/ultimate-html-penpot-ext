import { afterEach, describe, expect, it } from "vitest";
import type { SceneDocument, SceneNode, ViewportSpec } from "../shared/contracts";
import { buildExtractorScript } from "./extractor";

const VIEWPORT: ViewportSpec = { id: "pseudo", name: "Pseudo", width: 400, height: 300 };
type Declared = Record<string, string>;
type Box = [x: number, y: number, width: number, height: number];

interface Page {
  /** Declared computed styles, keyed by element id. */
  elements?: Record<string, Declared>;
  /** Declared computed styles keyed by `id::before` or `id::after`. */
  pseudos?: Record<string, Declared>;
  /** Layout box of each host, keyed by element id (the default is 100x40 at 20,10). */
  hosts?: Record<string, Box>;
  /** Layout box of a pseudo-element's stand-in, keyed like `pseudos`. */
  boxes?: Record<string, Box>;
  /** Text-line boxes, keyed like `pseudos`. */
  lines?: Record<string, Box[]>;
  /** Called while a stand-in is attached, to observe the temporary DOM. */
  onMeasure?: (marker: HTMLElement, host: HTMLElement) => void;
  /** Move a host while its stand-in is attached, as a reacting selector would. */
  moveHost?: string;
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** A computed style that, like the browser's, lists longhands by index. */
function computedStyle(values: Declared): CSSStyleDeclaration {
  const names = Object.keys(values);
  const style: Record<string | number, unknown> = { ...values, length: names.length };
  names.forEach((name, index) => { style[index] = kebab(name); });
  style.getPropertyValue = (property: string) => values[Object.keys(values).find((name) => kebab(name) === property) ?? ""] ?? "";
  style.getPropertyPriority = () => "";
  return style as unknown as CSSStyleDeclaration;
}

function rect([x, y, width, height]: Box) {
  return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) };
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

/** Supply browser-computed values and layout boxes: jsdom has no layout, no
 * pseudo-element styles, and no Range geometry. */
function installBrowser(page: Page): () => void {
  const originalBounds = HTMLElement.prototype.getBoundingClientRect;
  const originalStyle = window.getComputedStyle;
  const originalRange = document.createRange;
  const originalCss = window.CSS;
  const hostBox = (id: string): Box => page.hosts?.[id] ?? [20, 10, 100, 40];
  let measuring: { key: string; host: HTMLElement } | undefined;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === document.body) return rect([0, 0, 400, 300]) as DOMRect;
    const pseudo = this.getAttribute("data-html-to-penpot-pseudo");
    if (pseudo) {
      const host = this.parentElement as HTMLElement;
      measuring = { key: `${host.id}${pseudo}`, host };
      page.onMeasure?.(this, host);
      return rect(page.boxes?.[measuring.key] ?? [0, 0, 0, 0]) as DOMRect;
    }
    const [x, y, width, height] = hostBox(this.id);
    // While a stand-in is attached, optionally behave as if a selector reacted to it.
    const moved = page.moveHost === this.id && this.hasAttribute("data-html-to-penpot-pseudo-host") ? 12 : 0;
    return rect([x, y, width + moved, height]) as DOMRect;
  };
  window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
    const base = originalStyle.call(window, element);
    const defaults: Declared = { opacity: "1", visibility: "visible", display: "block", backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", boxShadow: "none", borderImageSource: "none", borderTopStyle: "none", borderRightStyle: "none", borderBottomStyle: "none", borderLeftStyle: "none", borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px", color: "rgb(1, 2, 3)", position: "static", zIndex: "auto", fontSize: "16px", whiteSpace: "normal", transform: "none", content: "none" };
    const key = pseudo ? `${element.id}${pseudo}` : element.id;
    const declared = pseudo ? page.pseudos?.[key] : page.elements?.[element.id];
    const merged = { ...defaults, ...declared };
    return new Proxy(computedStyle(merged), {
      get: (target, property) => property in target ? (target as unknown as Record<string | symbol, unknown>)[property] : (base as unknown as Record<string | symbol, unknown>)[property]
    });
  }) as typeof window.getComputedStyle;
  document.createRange = (() => {
    let node: Node | undefined;
    return {
      selectNodeContents: (target: Node) => { node = target; },
      setStart: () => undefined,
      setEnd: () => undefined,
      getClientRects: () => {
        const host = node?.parentElement?.getAttribute("data-html-to-penpot-pseudo") ? node.parentElement.parentElement : undefined;
        const key = `${host?.id}${node?.parentElement?.getAttribute("data-html-to-penpot-pseudo")}`;
        return (page.lines?.[key] ?? [[22, 12, 40, 12]]).map(rect);
      },
      getBoundingClientRect: () => rect([22, 12, 40, 12])
    };
  }) as unknown as typeof document.createRange;
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

describe("extractor pseudo-elements", () => {
  let restore: (() => void) | undefined;
  afterEach(() => { restore?.(); restore = undefined; document.head.querySelectorAll("style").forEach((style) => style.remove()); });

  it("measures a positioned content-less box through a stand-in and leaves no trace in the page", async () => {
    document.body.innerHTML = '<div id="host">Inbox</div>';
    const observed: Array<{ position: string; hiddenBy: string; before: string | null; host: boolean }> = [];
    restore = installBrowser({
      elements: { host: { position: "relative" } },
      pseudos: { "host::after": { content: '""', position: "absolute", top: "-7px", right: "-7px", width: "14px", height: "14px", backgroundColor: "rgb(220, 38, 38)", borderTopLeftRadius: "7px", borderTopRightRadius: "7px", borderBottomRightRadius: "7px", borderBottomLeftRadius: "7px" } },
      boxes: { "host::after": [113, 3, 14, 14] },
      onMeasure: (marker, host) => observed.push({
        // The stand-in carries the pseudo-element's computed style, and the real one is hidden.
        position: marker.style.getPropertyValue("position"),
        hiddenBy: [...document.head.querySelectorAll("style")].map((style) => style.textContent).join(""),
        before: marker.getAttribute("data-html-to-penpot-pseudo"),
        host: host.hasAttribute("data-html-to-penpot-pseudo-host")
      })
    });
    const scene = await captureScript("pseudo-box");
    const host = bySource(scene, "#host");
    const dot = bySource(scene, "#host ::after");
    expect(host.kind).toBe("container");
    expect(dot).toMatchObject({ kind: "box", parentId: host.id, name: "::after", rect: { x: 113, y: 3, width: 14, height: 14 }, zIndex: 0, zIndexAuto: true });
    expect(dot.paint).toMatchObject({ backgroundColor: "rgb(220, 38, 38)", radius: [7, 7, 7, 7] });
    expect(dot.layout).toMatchObject({ absolute: true, positioned: true });
    expect(host.children).toEqual([expect.any(String), dot.id]);
    expect(observed).toEqual([{ position: "absolute", hiddenBy: expect.stringMatching(/\[data-html-to-penpot-pseudo-host\].*::after\{content:none!important\}/), before: "::after", host: true }]);
    expect(document.querySelector("#host")?.outerHTML).toBe('<div id="host">Inbox</div>');
    expect(document.head.querySelectorAll("style")).toHaveLength(0);
  });

  it("places ::before ahead of, and ::after behind, the host's own children", async () => {
    document.body.innerHTML = '<div id="host">Body</div>';
    restore = installBrowser({
      pseudos: {
        "host::before": { content: '""', display: "block", height: "4px", backgroundColor: "rgb(1, 1, 1)" },
        "host::after": { content: '""', display: "block", height: "4px", backgroundColor: "rgb(2, 2, 2)" }
      },
      boxes: { "host::before": [20, 10, 100, 4], "host::after": [20, 46, 100, 4] }
    });
    const scene = await captureScript("pseudo-order");
    const host = bySource(scene, "#host");
    const order = host.children.map((id) => scene.nodes.find((node) => node.id === id)?.source);
    expect(order).toEqual(["#host ::before", "#host ::text", "#host ::after"]);
  });

  it("imports generated text at its measured line, and keeps only its string parts", async () => {
    document.body.innerHTML = '<div id="host">Starred</div><div id="numbered">Row</div>';
    restore = installBrowser({
      pseudos: {
        "host::before": { content: '"\\"★\\" "', color: "rgb(217, 119, 6)", display: "inline", opacity: "0.5" },
        "numbered::before": { content: 'counter(item) ". "', display: "inline" }
      },
      boxes: { "host::before": [20, 10, 22, 16], "numbered::before": [20, 10, 12, 16] },
      lines: { "host::before": [[20, 11, 19, 14]], "numbered::before": [[24, 11, 8, 14]] }
    });
    const scene = await captureScript("pseudo-text");
    const icon = bySource(scene, "#host ::before");
    expect(icon).toMatchObject({ kind: "text", text: '"★"', rect: { x: 20, y: 11, width: 19, height: 14 }, textNoWrap: true, paint: { color: "rgb(217, 119, 6)", opacity: 0.5 } });
    expect(icon.textStyle).toMatchObject({ textAlign: "left" });
    expect(bySource(scene, "#numbered ::before")).toMatchObject({ kind: "text", text: "." });
    expect(scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_PSEUDO_CONTENT")).toEqual([
      expect.objectContaining({ source: "#numbered ::before", message: expect.stringContaining("counter(item)") })
    ]);
  });

  it("decodes escapes, ignores alternative text, and reports content with no string part", async () => {
    document.body.innerHTML = '<div id="escaped"></div><div id="alt"></div><div id="image"></div>';
    restore = installBrowser({
      pseudos: {
        "escaped::before": { content: '"\\201C  a\\a b\\\\ \\""', display: "inline" },
        "alt::before": { content: '"label" / "spoken alternative"', display: "inline" },
        "image::before": { content: 'url("data:image/gif;base64,R0lGODlhAQABAAAAACw=")', display: "inline" }
      },
      boxes: { "escaped::before": [20, 10, 40, 12], "alt::before": [20, 10, 40, 12], "image::before": [20, 10, 20, 20] }
    });
    const scene = await captureScript("pseudo-content");
    expect(bySource(scene, "#escaped ::before").text).toBe("“ a b\\ \"");
    expect(bySource(scene, "#alt ::before").text).toBe("label");
    expect(scene.nodes.some((node) => node.source === "#image ::before")).toBe(false);
    expect(scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_PSEUDO_CONTENT").map((diagnostic) => diagnostic.source)).toEqual(["#image ::before"]);
  });

  it("keeps generated text with its own decoration as a container with a text child", async () => {
    document.body.innerHTML = '<div id="host">Notes</div>';
    restore = installBrowser({
      pseudos: { "host::before": { content: '"NEW"', display: "inline-block", backgroundColor: "rgb(22, 163, 74)", color: "rgb(255, 255, 255)" } },
      boxes: { "host::before": [20, 10, 44, 21] },
      lines: { "host::before": [[26, 13, 32, 14]] }
    });
    const scene = await captureScript("pseudo-chip");
    const chip = bySource(scene, "#host ::before");
    expect(chip).toMatchObject({ kind: "container", rect: { x: 20, y: 10, width: 44, height: 21 } });
    expect(chip.paint.backgroundColor).toBe("rgb(22, 163, 74)");
    expect(scene.nodes.filter((node) => node.parentId === chip.id)).toEqual([expect.objectContaining({ kind: "text", text: "NEW", rect: { x: 26, y: 13, width: 32, height: 14 }, paint: expect.objectContaining({ color: "rgb(255, 255, 255)", opacity: 1 }) })]);
  });

  it("splits preserved line breaks in generated text into one layer per line", async () => {
    document.body.innerHTML = '<div id="host"></div>';
    restore = installBrowser({
      pseudos: { "host::before": { content: '"one\\a two"', display: "block", whiteSpace: "pre" } },
      boxes: { "host::before": [20, 10, 30, 28] },
      lines: { "host::before": [[20, 10, 24, 14], [20, 24, 24, 14]] }
    });
    const scene = await captureScript("pseudo-lines");
    const generated = bySource(scene, "#host ::before");
    expect(generated.kind).toBe("container");
    expect(scene.nodes.filter((node) => node.parentId === generated.id).map((node) => node.text)).toEqual(["one", "two"]);
  });

  it("composes a centered rotation into the pseudo-element's own frame and diagnoses what it cannot", async () => {
    document.body.innerHTML = '<div id="host">Diamond</div>';
    const turn = Math.SQRT1_2;
    restore = installBrowser({
      pseudos: {
        "host::after": { content: '""', position: "absolute", width: "28px", height: "28px", backgroundColor: "rgb(124, 58, 237)", transform: `matrix(${turn}, ${turn}, ${-turn}, ${turn}, -14, -14)`, transformOrigin: "14px 14px" },
        "host::before": { content: '""', position: "absolute", width: "28px", height: "28px", backgroundColor: "rgb(124, 58, 237)", transform: "matrix(1, 0, 0.36, 1, 0, 0)", transformOrigin: "14px 14px" }
      },
      boxes: { "host::after": [100, 20, 28, 28], "host::before": [10, 20, 28, 28] }
    });
    const scene = await captureScript("pseudo-transform");
    const diamond = bySource(scene, "#host ::after");
    expect(diamond.rotation).toBe(45);
    expect(diamond.rect.width).toBe(28);
    expect(diamond.rect.height).toBe(28);
    expect(bySource(scene, "#host ::before").rotation).toBeUndefined();
    expect(scene.diagnostics.filter((diagnostic) => diagnostic.code === "UNSUPPORTED_TRANSFORM")).toEqual([expect.objectContaining({ source: "#host ::before" })]);
  });

  it("warns when measuring the pseudo-element moves its host", async () => {
    document.body.innerHTML = '<div id="host">Row</div>';
    restore = installBrowser({
      pseudos: { "host::before": { content: '""', display: "block", height: "4px", backgroundColor: "rgb(1, 1, 1)" } },
      boxes: { "host::before": [20, 10, 100, 4] },
      moveHost: "host"
    });
    const scene = await captureScript("pseudo-drift");
    expect(scene.diagnostics).toEqual([expect.objectContaining({ code: "PSEUDO_ELEMENT_GEOMETRY_UNVERIFIED", source: "#host ::before" })]);
    expect(bySource(scene, "#host ::before").kind).toBe("box");
  });

  it("creates nothing for hidden, empty, undecorated, or zero-size generated content", async () => {
    document.body.innerHTML = '<div id="none"></div><div id="hidden"></div><div id="clear"></div><div id="flat"></div><div id="transparent"></div>';
    restore = installBrowser({
      pseudos: {
        "none::before": { content: '"text"', display: "none" },
        "hidden::before": { content: '"text"', visibility: "hidden" },
        "clear::after": { content: '""', display: "table" },
        "flat::before": { content: '""', display: "block", backgroundColor: "rgb(1, 1, 1)" },
        "transparent::after": { content: '"text"', opacity: "0" }
      },
      boxes: { "flat::before": [20, 10, 0, 0] }
    });
    const scene = await captureScript("pseudo-empty");
    expect(scene.nodes.filter((node) => /::(before|after)/.test(node.source))).toEqual([]);
    expect(scene.diagnostics).toEqual([]);
  });

  it("keeps an omitted wrapper's generated content in source order under its surviving ancestor", async () => {
    document.body.innerHTML = '<div id="row"><span id="wrapper">Noted</span></div>';
    restore = installBrowser({
      elements: { wrapper: { display: "contents" } },
      pseudos: { "wrapper::before": { content: '"\\25C6 "', display: "inline" } },
      hosts: { row: [20, 10, 100, 40], wrapper: [0, 0, 0, 0] },
      boxes: { "wrapper::before": [20, 10, 14, 16] },
      lines: { "wrapper::before": [[20, 11, 12, 14]] }
    });
    const scene = await captureScript("pseudo-contents");
    const row = bySource(scene, "#row");
    const order = row.children.map((id) => scene.nodes.find((node) => node.id === id)?.source);
    expect(order).toEqual(["#wrapper ::before", "#wrapper ::text"]);
    expect(bySource(scene, "#wrapper ::before")).toMatchObject({ kind: "text", parentId: row.id, text: "◆" });
  });

  it("falls back, with a diagnostic, for a pseudo-element that needs a raster fallback", async () => {
    document.body.innerHTML = '<div id="host">Blur</div>';
    restore = installBrowser({
      pseudos: { "host::after": { content: '""', position: "absolute", backgroundColor: "rgb(1, 1, 1)", filter: "blur(4px)" } },
      boxes: { "host::after": [20, 10, 60, 20] }
    });
    const scene = await captureScript("pseudo-fallback");
    expect(bySource(scene, "#host ::after")).toMatchObject({ kind: "fallback", fallbackReason: "CSS filter needs a raster fallback" });
    expect(scene.diagnostics).toEqual([expect.objectContaining({ code: "UNSUPPORTED_SUBTREE", source: "#host ::after" })]);
  });

  it("gives a positioned pseudo-element its own stacking position", async () => {
    document.body.innerHTML = '<div id="host">Layered</div>';
    restore = installBrowser({
      pseudos: { "host::before": { content: '""', position: "absolute", zIndex: "-1", backgroundColor: "rgb(1, 1, 1)" } },
      boxes: { "host::before": [20, 10, 100, 40] }
    });
    const scene = await captureScript("pseudo-stacking");
    expect(bySource(scene, "#host ::before")).toMatchObject({ zIndex: -1, zIndexAuto: false, layout: expect.objectContaining({ positioned: true }) });
    expect(bySource(scene, "#host")).toMatchObject({ zIndex: 0, zIndexAuto: true });
  });
});
