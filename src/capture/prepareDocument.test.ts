import { describe, expect, it } from "vitest";
import { isSafeBaseUrl, prepareSandboxDocument } from "./prepareDocument";
import type { ViewportSpec } from "../shared/contracts";

const viewport: ViewportSpec = { id: "desktop", name: "Desktop", width: 1440, height: 900 };

describe("sandbox document preparation", () => {
  it("accepts only web base URLs", () => {
    expect(isSafeBaseUrl("https://example.com/assets/")).toBe(true);
    expect(isSafeBaseUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeBaseUrl("file:///tmp/page")).toBe(false);
  });

  it("removes supplied scripts when scripts are disabled", () => {
    const result = prepareSandboxDocument({ html: "<script>window.bad = true</script><main>Hello</main>", baseUrl: "https://example.com/", scriptPolicy: "off", token: "test", viewport, settleDelayMs: 0 });
    expect(result).not.toContain("window.bad");
    expect(result).toContain("data-html-to-penpot-scripts-disabled=\"1\"");
    expect(result).toContain("Content-Security-Policy");
    expect(result).toContain("<base href=\"https://example.com/\">");
  });

  it("keeps trusted scripts but gives them a nonce", () => {
    const result = prepareSandboxDocument({ html: "<script src=\"app.js\"></script>", scriptPolicy: "trusted", token: "test", viewport, settleDelayMs: 0 });
    expect(result).toContain("src=\"app.js\" nonce=");
    expect(result).toContain("connect-src http: https:");
  });
});
