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
    expect(script).toContain("textNoWrap");
    expect(script).toContain("inlineControlAncestor");
    expect(script).toContain("one fixed text box per source line");
    expect(script).toContain("textNoWrap: true");
    expect(script).toContain("const paintOfElement");
    expect(script).toContain("document.documentElement");
    expect(script).toContain("rgb(255, 255, 255)");
    expect(script).toContain("const dataUrl");
    expect(script).toContain('if (tag === "br") return');
    expect(script).toContain("waitForDomSettle");
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
});
