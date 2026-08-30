import { afterEach, describe, expect, it, vi } from "vitest";
import { inlineWebFonts } from "./fonts";

const FONT_BYTES = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]);

function fontResponse(contentType = "font/woff2") {
  return new Response(FONT_BYTES.slice(), { status: 200, headers: { "content-type": contentType } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { location?: Location }).location;
});

describe("webfont inlining", () => {
  it("returns HTML untouched without a base URL", async () => {
    const html = "<style>@font-face{font-family:'x';src:url(/f.woff2)}</style><p>hi</p>";
    await expect(inlineWebFonts(html)).resolves.toBe(html);
  });

  it("returns HTML untouched when no @font-face rules exist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const html = "<style>body{color:red}</style>";
    await expect(inlineWebFonts(html, "https://example.com/")).resolves.toBe(html);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("appends an override stylesheet with data: font sources", async () => {
    (globalThis as { location?: Location }).location = { origin: "http://localhost:4173", hostname: "localhost" } as Location;
    const fetchMock = vi.fn().mockResolvedValue(fontResponse());
    vi.stubGlobal("fetch", fetchMock);
    const html = "<html><head><style>@font-face{font-family:'bryant';src:url(/includes/f.woff2) format('woff2');}</style></head><body><p>x</p></body></html>";

    const result = await inlineWebFonts(html, "https://example.com/page");

    expect(result).toContain("data-html-to-penpot-fonts");
    expect(result).toContain("data:font/woff2;base64");
    expect(result).toContain("font-family:'bryant'");
    // Original rules stay in place as the fallback path.
    expect(result).toContain("url(/includes/f.woff2)");
    // Direct same-origin-style fetch first: the font URL resolved against base.
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://example.com/includes/f.woff2", expect.objectContaining({ credentials: "omit" }));
  });

  it("falls back to the local proxy for CORS-blocked fonts", async () => {
    (globalThis as { location?: Location }).location = { origin: "http://localhost:4173", hostname: "localhost" } as Location;
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(fontResponse("font/woff"));
    vi.stubGlobal("fetch", fetchMock);
    const html = "<style>@font-face{font-family:'a';src:url(https://fonts.example/a.woff)}</style>";

    const result = await inlineWebFonts(html, "https://example.com/");

    expect(result).toContain("data:font/woff;base64");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:4173/__html_to_penpot/fetch?mode=font&url=https%3A%2F%2Ffonts.example%2Fa.woff",
      expect.objectContaining({ credentials: "omit" })
    );
  });

  it("collects fonts from linked stylesheets", async () => {
    (globalThis as { location?: Location }).location = { origin: "http://localhost:4173", hostname: "localhost" } as Location;
    const css = "@font-face{font-family:'linked';src:url(/fonts/l.woff2) format('woff2')}";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(css, { status: 200, headers: { "content-type": "text/css" } }))
      .mockResolvedValue(fontResponse());
    vi.stubGlobal("fetch", fetchMock);
    const html = "<html><head><link rel=\"stylesheet\" href=\"/css/site.css\"></head><body></body></html>";

    const result = await inlineWebFonts(html, "https://example.com/");

    expect(result).toContain("data:font/woff2;base64");
    expect(result).toContain("font-family:'linked'");
    // The <link> itself is never removed.
    expect(result).toContain("<link rel=\"stylesheet\" href=\"/css/site.css\">");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://example.com/css/site.css", expect.objectContaining({ credentials: "omit" }));
  });

  it("keeps rules with local() or already-inline sources out of the rewrite", async () => {
    (globalThis as { location?: Location }).location = { origin: "http://localhost:4173", hostname: "localhost" } as Location;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const html = "<style>@font-face{font-family:'sys';src:local('Helvetica')}</style><style>@font-face{font-family:'d';src:url(data:font/woff2;base64,AAAA)}</style>";

    await expect(inlineWebFonts(html, "https://example.com/")).resolves.toBe(html);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a whole font-face rule when one of its sources cannot be fetched", async () => {
    (globalThis as { location?: Location }).location = { origin: "http://localhost:4173", hostname: "localhost" } as Location;
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const html = "<style>@font-face{font-family:'a';src:url(https://f.example/missing.woff2)}</style>";

    await expect(inlineWebFonts(html, "https://example.com/")).resolves.toBe(html);
  });

  it("drops legacy eot/svg sources and keeps descriptors that follow src", async () => {
    (globalThis as { location?: Location }).location = { origin: "http://localhost:4173", hostname: "localhost" } as Location;
    const fetchMock = vi.fn().mockResolvedValue(fontResponse());
    vi.stubGlobal("fetch", fetchMock);
    const html = "<style>@font-face{font-weight:bold;src:url(/a.eot);src:url(/a.woff2) format('woff2'),url(/a.svg#x) format('svg');font-display:swap;font-family:'a'}</style>";

    const result = await inlineWebFonts(html, "https://example.com/");

    const override = result.match(/<style data-html-to-penpot-fonts="">([\s\S]*?)<\/style>/)?.[1] || "";
    expect(override).toContain("data:font/woff2;base64");
    expect(override).toContain("font-display:swap");
    expect(override).toContain("font-weight:bold");
    expect(override).not.toContain(".eot");
    expect(override).not.toContain(".svg");
    // Only the woff2 source was fetched, never the legacy formats.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/a.woff2", expect.anything());
  });

  it("caps the number of fetched fonts", async () => {
    (globalThis as { location?: Location }).location = { origin: "http://localhost:4173", hostname: "localhost" } as Location;
    const fetchMock = vi.fn().mockResolvedValue(fontResponse());
    vi.stubGlobal("fetch", fetchMock);
    const faces = Array.from({ length: 40 }, (_, i) => `@font-face{font-family:'f${i}';src:url(/f${i}.woff2)}`).join("");
    const html = `<style>${faces}</style>`;

    const result = await inlineWebFonts(html, "https://example.com/");

    expect(fetchMock).toHaveBeenCalledTimes(24);
    expect(result).toContain("data:font/woff2;base64");
  });

  it("rejects oversized font responses", async () => {
    (globalThis as { location?: Location }).location = { origin: "http://localhost:4173", hostname: "localhost" } as Location;
    const big = new Uint8Array(2 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(big, { status: 200, headers: { "content-type": "font/woff2" } })));
    const html = "<style>@font-face{font-family:'a';src:url(/big.woff2)}</style>";

    await expect(inlineWebFonts(html, "https://example.com/")).resolves.toBe(html);
  });
});
