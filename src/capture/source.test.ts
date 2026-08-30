import { describe, expect, it, vi } from "vitest";
import { resolveSource, sourceUrl } from "./source";

describe("page source resolution", () => {
  it("recognizes only complete HTTP(S) URLs", () => {
    expect(sourceUrl("https://example.com/page")).toBe("https://example.com/page");
    expect(sourceUrl("  http://localhost:3000/  ")).toBe("http://localhost:3000/");
    expect(sourceUrl("<main>Hello</main>")).toBeUndefined();
    expect(sourceUrl("https://example.com/page and more")).toBeUndefined();
  });

  it("keeps pasted HTML and its explicit base URL", async () => {
    await expect(resolveSource("<main>Hello</main>", "https://example.com/assets/")).resolves.toEqual({
      html: "<main>Hello</main>",
      baseUrl: "https://example.com/assets/"
    });
  });

  it("fetches a URL and uses it as the default asset base", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<main>Remote</main>", { status: 200 })));
    await expect(resolveSource("https://example.com/page")).resolves.toEqual({
      html: "<main>Remote</main>",
      baseUrl: "https://example.com/page",
      sourceUrl: "https://example.com/page"
    });
    vi.unstubAllGlobals();
  });

  it("inlines same-page SVG image assets for editable Penpot import", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<main><img src="/logo.svg"></main>', { status: 200 }))
      .mockResolvedValueOnce(new Response("<svg viewBox='0 0 10 10'><path d='M0 0h10v10z'/></svg>", {
        status: 200,
        headers: { "content-type": "image/svg+xml" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveSource("https://example.com/page");

    expect(result.html).toContain("data:image/svg+xml,");
    expect(result.html).not.toContain('src="/logo.svg"');
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://example.com/logo.svg", expect.objectContaining({ credentials: "omit" }));
    vi.unstubAllGlobals();
  });

  it("inlines raster image assets so Penpot receives bytes instead of remote URLs", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<main><img src="/logo.png"><div style="background-image: url(\'/hero.jpg\')"></div></main>', { status: 200 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5]), { status: 200, headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveSource("https://example.com/page");

    expect(result.html).toContain("data:image/png;base64,AQID");
    expect(result.html).toContain("data:image/jpeg;base64,BAU=");
    expect(result.html).not.toContain('src="/logo.png"');
    expect(result.html).not.toContain("/hero.jpg");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://example.com/logo.png", expect.objectContaining({ credentials: "omit" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, expect.stringContaining("mode=asset&url=https%3A%2F%2Fexample.com%2Flogo.png"), { credentials: "omit" });
    expect(fetchMock).toHaveBeenNthCalledWith(4, "https://example.com/hero.jpg", expect.objectContaining({ credentials: "omit" }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, expect.stringContaining("mode=asset&url=https%3A%2F%2Fexample.com%2Fhero.jpg"), { credentials: "omit" });
    vi.unstubAllGlobals();
  });

  it("inlines loader-injected styles and their image assets", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<html><head><script>var _jqqreqcss=["/includes/site.css"];</script></head><body><img src="/images/logo.png"><div class="hero"></div></body></html>', { status: 200 }))
      .mockResolvedValueOnce(new Response('.social_icon{display:inline-block}.hero{background-image:url(../images/hero.png)}', { status: 200, headers: { "content-type": "text/css" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4, 5]), { status: 200, headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveSource("https://example.com/page");

    expect(result.html).toContain("data-html-to-penpot-stylesheet");
    expect(result.html).toContain(".social_icon");
    expect(result.html).toContain("data:image/png;base64,AQID");
    expect(result.html).toContain("data:image/png;base64,BAU=");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://example.com/includes/site.css", expect.objectContaining({ credentials: "omit" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://example.com/images/logo.png", expect.objectContaining({ credentials: "omit" }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "https://example.com/images/hero.png", expect.objectContaining({ credentials: "omit" }));
    vi.unstubAllGlobals();
  });

  it("prioritizes raster images without spending the budget on SVG icons", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<main><img src="/social.svg"><img src="/logo.png"></main>', { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } }))
      .mockResolvedValueOnce(new Response("<svg viewBox='0 0 10 10'><path d='M0 0h10v10z'/></svg>", { status: 200, headers: { "content-type": "image/svg+xml" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveSource("https://example.com/page");

    expect(result.html).toContain("data:image/png;base64,AQID");
    expect(result.html).toContain("data:image/svg+xml,");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://example.com/logo.png", expect.objectContaining({ credentials: "omit" }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://example.com/social.svg", expect.objectContaining({ credentials: "omit" }));
    vi.unstubAllGlobals();
  });

  it("falls back to the local proxy when direct URL loading is blocked by CORS", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("<main>Proxied</main>", {
        status: 200,
        headers: { "X-HTML-Source-URL": "https://example.com/final" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveSource("https://example.com/page")).resolves.toEqual({
      html: "<main>Proxied</main>",
      baseUrl: "https://example.com/final",
      sourceUrl: "https://example.com/page"
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining("/__html_to_penpot/fetch?mode=html&url=https%3A%2F%2Fexample.com%2Fpage"), expect.objectContaining({ credentials: "omit" }));
    vi.unstubAllGlobals();
  });

  it("uses the build-time configured fetch service before the local dev proxy", async () => {
    vi.stubEnv("VITE_FETCH_PROXY_ORIGIN", "https://svc.example.com/");
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("<main>Served</main>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveSource("https://example.com/page")).resolves.toEqual({
      html: "<main>Served</main>",
      baseUrl: "https://example.com/page",
      sourceUrl: "https://example.com/page"
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://svc.example.com/api/fetch-html?mode=html&url=https%3A%2F%2Fexample.com%2Fpage",
      { credentials: "omit" }
    );
    vi.unstubAllGlobals();
  });

  it("does not fall back to the service when the origin answers with an HTTP error", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("gone", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveSource("https://example.com/page")).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("surfaces normalised service rejections", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "That address is not reachable through the import service." }), {
        status: 403,
        headers: { "content-type": "application/json" }
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveSource("https://10.0.0.5/")).rejects.toThrow(/not reachable through the import service/);
    vi.unstubAllGlobals();
  });
});
