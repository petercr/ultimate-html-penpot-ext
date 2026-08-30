import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNetworkShim, isSafeBaseUrl, prepareSandboxDocument } from "./prepareDocument";
import type { ViewportSpec } from "../shared/contracts";

const viewport: ViewportSpec = { id: "desktop", name: "Desktop", width: 1440, height: 900 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (globalThis as { location?: Location }).location;
});

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

  it("prepends the network shim ahead of page scripts in trusted mode with a proxy", () => {
    (globalThis as { location?: Location }).location = { origin: "http://localhost:4173", hostname: "localhost" } as Location;
    const html = "<head><script>var first = true;</script></head><body></body>";
    const result = prepareSandboxDocument({ html, baseUrl: "https://example.com/page", scriptPolicy: "trusted", token: "test", viewport, settleDelayMs: 0 });
    const shimIndex = result.indexOf("mode=asset");
    const scriptIndex = result.indexOf("var first");
    expect(shimIndex).toBeGreaterThan(-1);
    expect(shimIndex).toBeLessThan(scriptIndex);
    expect(result).toContain("http://localhost:4173/__html_to_penpot/fetch");
    expect(result).toContain('"https://example.com"');
  });

  it("injects the build-time service proxy into the trusted shim", () => {
    (globalThis as { location?: Location }).location = { origin: "http://localhost:4173", hostname: "localhost" } as Location;
    vi.stubEnv("VITE_FETCH_PROXY_ORIGIN", "https://svc.example.com/");
    const result = prepareSandboxDocument({ html: "<body></body>", baseUrl: "https://example.com/", scriptPolicy: "trusted", token: "test", viewport, settleDelayMs: 0 });
    expect(result).toContain('"https://svc.example.com/api/fetch-html"');
    expect(result).not.toContain("__html_to_penpot/fetch");
  });

  it("omits the network shim when scripts are off", () => {
    (globalThis as { location?: Location }).location = { origin: "http://localhost:4173", hostname: "localhost" } as Location;
    const result = prepareSandboxDocument({ html: "<script>x()</script><body></body>", baseUrl: "https://example.com/", scriptPolicy: "off", token: "test", viewport, settleDelayMs: 0 });
    expect(result).not.toContain("mode=asset");
  });

  it("omits the network shim when no proxy is configured", () => {
    (globalThis as { location?: Location }).location = { origin: "https://plugin.example.com", hostname: "plugin.example.com" } as Location;
    const result = prepareSandboxDocument({ html: "<body></body>", baseUrl: "https://example.com/", scriptPolicy: "trusted", token: "test", viewport, settleDelayMs: 0 });
    expect(result).not.toContain("mode=asset");
  });

  it("rewrites only same-origin GET requests to the page origin", () => {
    const shim = buildNetworkShim("https://example.com", "https://svc.example.com/api/fetch-html");
    expect(shim).toContain("baseOrigin");
    expect(shim).toContain('"GET"');
    // The shim body must not rewrite by default; assertions on behavior live
    // in browser-level integration tests.
    expect(shim).toContain("mode=asset");
  });
});
