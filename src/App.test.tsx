import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App source fields", () => {
  it("puts the HTML-or-URL source before the optional Base URL", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup.indexOf('id="html-source"')).toBeGreaterThan(-1);
    expect(markup.indexOf('id="html-source"')).toBeLessThan(markup.indexOf('id="base-url"'));
    expect(markup).toContain("HTML or page URL");
    expect(markup).toContain("https://example.com/page");
    expect(markup).toContain("Page URLs are best-effort");
    expect(markup).toContain("CORS");
  });
});

describe("App standalone mode", () => {
  it("explains that Import needs Penpot and keeps Import disabled when no host frame exists", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("outside Penpot");
    expect(markup).toContain("plugin manager to import");
    expect(markup).toContain('title="Importing requires Penpot');
    expect(markup.match(/<button[^>]*class="primary"[^>]*>/)?.[0]).toContain("disabled");
  });

  it("omits the standalone notice for an embedded host frame", () => {
    const markup = renderToStaticMarkup(<App standaloneHost={false} />);

    expect(markup).not.toContain("outside Penpot");
    expect(markup).not.toContain("Importing requires Penpot");
  });
});
