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
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining("/__html_to_penpot/fetch?url=https%3A%2F%2Fexample.com%2Fpage"), expect.objectContaining({ credentials: "omit" }));
    vi.unstubAllGlobals();
  });
});
