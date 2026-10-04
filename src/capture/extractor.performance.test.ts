import { afterEach, describe, expect, it, vi } from "vitest";
import { buildExtractorScript } from "./extractor";
import type { SceneDocument } from "../shared/contracts";
import type { CaptureMetrics } from "../shared/performance";

function rect(top = 0, width = 80) {
  return { x: 2, y: top, left: 2, top, right: 2 + width, bottom: top + 12, width, height: 12, toJSON: () => ({}) };
}

function runCapture(): Promise<{ scene: SceneDocument; metrics: Omit<CaptureMetrics, "durationMs" | "preparationMs"> }> {
  const token = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timeout); window.removeEventListener("message", receive); };
    const receive = (event: MessageEvent) => {
      if (event.data?.token !== token) return;
      clean();
      if (event.data.type === "CAPTURE_ERROR") reject(new Error(event.data.message));
      else resolve(event.data);
    };
    const timeout = setTimeout(() => { clean(); reject(new Error("Capture timed out")); }, 5_000);
    window.addEventListener("message", receive);
    window.eval(buildExtractorScript(token, { id: "test", name: "Test", width: 300, height: 200 }, 0, undefined, true));
  });
}

function prepare(content: string, whiteSpace = "normal") {
  document.body.innerHTML = `<p id="sample" style="opacity:1;visibility:visible;white-space:${whiteSpace};background-color:transparent;background-image:none;border-top-style:none;box-shadow:none">${content}</p>`;
  document.body.style.cssText = "opacity:1;visibility:visible;background-color:transparent;background-image:none;box-shadow:none";
  const nativeStyle = window.getComputedStyle;
  const styles = vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => pseudo
    ? { content: "none", display: "none" } as CSSStyleDeclaration
    : nativeStyle.call(window, element));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(0, 300));
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  return styles;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; document.body.removeAttribute("style"); });

describe("capture text measurement", () => {
  it("uses line rectangles for single-line text, including comment-separated runs and Unicode", async () => {
    const styles = prepare("Hello 👩🏽‍💻<!-- split --> café&nbsp;日本語");
    const bounds = vi.fn(() => { throw new Error("Single-line text must not measure individual characters"); });
    vi.spyOn(document, "createRange").mockImplementation(() => ({ selectNodeContents: () => undefined, getClientRects: () => [rect()], getBoundingClientRect: bounds }) as unknown as Range);
    const { scene, metrics } = await runCapture();
    expect(scene.nodes.find((node) => node.source === "#sample")?.text).toBe("Hello 👩🏽‍💻 café\u00a0日本語");
    expect(bounds).not.toHaveBeenCalled();
    expect(metrics.textRangeReads).toBe(2);
    const sample = document.querySelector("p");
    expect(styles.mock.calls.filter(([element, pseudo]) => element === sample && !pseudo)).toHaveLength(1);
    expect(scene).not.toHaveProperty("metrics");
  });

  it("measures wrapped text at grapheme boundaries once and keeps complete source lines", async () => {
    const raw = "A👩🏽‍💻e\u0301\nB🇯🇵";
    prepare(raw, "pre-wrap");
    const measured: string[] = [];
    let node: Node;
    let start = 0;
    let end = 0;
    vi.spyOn(document, "createRange").mockImplementation(() => ({
      selectNodeContents: (value: Node) => { node = value; },
      getClientRects: () => [rect(0), rect(20)],
      setStart: (_value: Node, offset: number) => { start = offset; },
      setEnd: (_value: Node, offset: number) => { end = offset; },
      getBoundingClientRect: () => { measured.push((node.textContent || "").slice(start, end)); return rect(start < raw.indexOf("\n") ? 0 : 20); }
    }) as unknown as Range);
    const { scene } = await runCapture();
    const parent = scene.nodes.find((candidate) => candidate.source === "#sample");
    expect(parent?.children.map((id) => scene.nodes.find((candidate) => candidate.id === id)?.text)).toEqual(["A👩🏽‍💻e\u0301", "B🇯🇵"]);
    const expected = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(raw)].map((item) => item.segment);
    expect(measured).toEqual(expected);
  });

  it("keeps surrogate pairs whole when the browser lacks Intl.Segmenter", async () => {
    const raw = "😀\n𠮷";
    prepare(raw, "pre-wrap");
    vi.stubGlobal("Intl", { Segmenter: undefined });
    const measured: string[] = [];
    let start = 0;
    let end = 0;
    vi.spyOn(document, "createRange").mockImplementation(() => ({
      selectNodeContents: () => undefined,
      getClientRects: () => [rect(0), rect(20)],
      setStart: (_value: Node, offset: number) => { start = offset; },
      setEnd: (_value: Node, offset: number) => { end = offset; },
      getBoundingClientRect: () => { measured.push(raw.slice(start, end)); return rect(start < 2 ? 0 : 20); }
    }) as unknown as Range);
    const { scene } = await runCapture();
    expect(measured).toEqual(["😀", "\n", "𠮷"]);
    expect(scene.nodes.filter((node) => node.kind === "text").map((node) => node.text)).toEqual(["😀", "𠮷"]);
  });
});
