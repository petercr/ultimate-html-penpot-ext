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
});
